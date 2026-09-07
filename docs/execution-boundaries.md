# 本地、远端执行与 edge cases

## 当前机制：能力路由，不是工具名称黑白名单

工具的 JavaScript 实现运行在本地 Harness。工具发起的文件/进程操作在哪里发生，取决于它调用的 **service provider**，不是工具名称、skill 所在目录或提示词。

已实现的调用链：

```text
DSH tools.execute(exec.agent)
  → routing.ts 的 tools/execute hook
  → Session ID → 本地 BindingStore → 已准备的 World
  → AsyncLocalStorage 保存本次调用的 World provider context
  → RoutedFileSystem / RoutedSubprocess 转发至具体 provider
  → client RPC → SSH stdio → 远端 helper 执行
```

[routing.ts](../integrations/dsh/plugins/ssh-world/src/routing.ts) 在缺失路由时抛错；[worlds.ts](../integrations/dsh/plugins/ssh-world/src/worlds.ts) 检查持久绑定、Agent 活跃绑定、cwd 与 runtime 状态。新增 session-admission 适配器通过宿主补丁在普通 Session 创建、恢复、接管和 fork 前执行准入；这条链路独立于工具调用的 ALS。工具调度之外的调用可以明确使用 `executionWorlds.forAgent(agent)`，但当前未自动覆盖全部模型 pre-step、初始化、上传和后台消费者。

目前 **没有** 自动分类全部工具的黑白名单，也没有可用的通用 local-shell 工具。以下机制必须区分：

| 机制 | 已有行为 | 不代表什么 |
| --- | --- | --- |
| DSH tool allow/deny | 原生工具可见性与调用权限、子 Agent 过滤 | 不决定工具的执行主机 |
| preset/profile 装配 | remote preset 显式装配文件/搜索/前台 Bash/Web 工具 | 不包含默认工具全集，也没有自动插件兼容检测 |
| execution World guard | 缺失/冲突 binding 拒绝；未打路径补丁的组合继续拒绝 `..` | 不是全部路径安全策略，也不是完整黑名单 |
| managed executable map | 仅把 DSH 已知的本地 packaged ripgrep 路径映射为已安装的远端 ripgrep | 不是命令白名单；其他 argv[0] 仍发送远端，不会改成本地执行 |
| helper 方法/参数检查 | 固定协议 API、合法参数、生命周期和资源限制 | 不是对可信插件任意本地 Node 代码的沙箱 |

任意插件若直接调用 `node:fs`、`child_process` 或本地 SDK，仍会在本地运行。替换 ctx.fs/ctx.subprocess 不能拦截它们。兼容装配必须适配或排除这类 workspace 消费者；本项目不 monkey-patch Node，也不承诺隔离恶意同进程插件。

## 哪些工作在哪里发生

| 工作 | 地点与机制 | 当前边界 |
| --- | --- | --- |
| 模型 API、Agent loop、插件 JS、Session JSONL、UI server | 本地宿主及其网络 | 保留 DSH 原生实现 |
| bindings、World catalog、配置、产物 cache | 本地控制数据 | 均由宿主维护，catalog 不存远端项目文件 |
| OpenSSH、身份认证、host verification、ProxyJump | 本地 SSH 客户端建立连接 | 复用用户 SSH 配置，不默认上传本地凭据 |
| 安装 helper/rg、启动和连接 runtime | 本地 orchestrator 通过 SSH 发控制命令到最终环境 | 属于 bootstrap，不是另一个 Agent shell |
| workspace read/write/edit、grep/glob | 远端 FS/subprocess provider → helper；搜索使用目标平台 rg | patched profile 由目标 FS 解析 `..` |
| workspace Shell、PTY、进程、信号与输出 | provider 传 argv/cwd/env 到远端 helper | 前台 Bash 已经浏览器验收；PTY/后台消费者不在当前 preset 中 |
| HTTPS web search / 连接器请求 | 若装配的是本地网络客户端，请求从本地发出 | remote preset 装配原生 Web 工具和宿主 DeepSeek search provider；受控端点已验收 |
| Shell 中 `curl`/搜索 CLI | 远端 Shell | 即使目的也是网络搜索，也不会按关键词切成本地 |
| 上传附件的持久存储 | 本地 DSH attachment store | 可留本地；远程工具读取需显式 transfer，尚未实现 |
| 本地用户/内置 skill 内容 | 可以通过独立本地 provider 提供文本 | 不自动获得本地执行权；默认 DSH skill provider 未全部远程适配 |
| 项目 AGENTS.md / 项目 skill / @文件补全 | 应从绑定 World 读取 | instruction 非工具路由、skill 扫描和补全仍在下阶段适配范围 |

“所有 workspace 操作走远端”是受支持装配必须满足的契约，不是当前对任意 DSH 插件都已强制成立的保证。

Web Search 是执行边界的重点验收对象：必须同时证明本地连接器的网络请求和凭据留在本地、同一 Session 的 Shell 网络命令仍在绑定 World 执行，且连接器失败不会改变执行地点。具体测试及证据门槛见[阶段计划中的 Web Search 验收](../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md#web-search-重点验收)。当前浏览器用例验证原生 provider 请求、测试凭据、远端 Shell 无法访问宿主 loopback 端点，以及远端 env 中没有连接器凭据；外部真实搜索服务、连接器故障/取消与双 Session 并发仍未验收。

## Skill 的位置不等于命令的位置

Skill 是指令和资源，不是独立执行域。模型读到本地 skill 后若调用已装配的远程 Shell，该命令仍在 World 中执行。

```text
本地 skill: python /Users/me/skills/report/run.py /workspace/input.csv
       ↓ 调用远程 Shell
远端收到同一 argv / command
       ↓
本地脚本路径通常不存在；本地 SDK、配置、凭据也不会自动跟过去
```

当前实现不会复制该脚本、改写任意 shell 字符串或在失败后重试本地。远端同名路径存在时也不能把它当成本地脚本的等价物。单独设置 execution-world 提示词不能解决文件、依赖和权限问题。

面向终态的支持分类如下；这是下阶段需要实现并验证的能力准入约定，不是已有 metadata schema 或自动 dispatcher：

| Skill 所需能力 | 支持方式 |
| --- | --- |
| 纯文本知识/操作指导 | 内容可来自本地；实际操作遵守所调用 capability 的 World |
| 远程项目命令与项目脚本 | 从远端发现，声明并检查目标环境依赖，通过该 World 执行 |
| 本地连接器/研究 API | 暴露独立、明确的本地服务工具；不能把通用远程 Shell 临时切成本地 |
| 随 skill 分发的可移植脚本 | 支持前需显式发布脚本/依赖到目标、校验版本与目标平台，并给出真实远端路径；当前没有此发布器 |
| 本地 CLI 依赖的 skill | 尚未提供通用执行方案。需要经审核的专用本地能力或迁移为远端工具；不因 skill 提及一个路径就开放任意 host shell |
| 同时需要本地 API 与远端项目数据 | 明确分步：远端读取/导出 → 显式数据传递 → 本地 API；结果写回同样显式 |

本地配置与凭据在本地连接器使用，项目命令使用远端环境的依赖和权限。外部 API 的调用授权、数据范围和本地/远端审批事实必须可辨识。任何 UI/prompt 分类都不能替代 provider 边界。

## 必须保持的边缘行为

| 情形 | 行为与实现状态 |
| --- | --- |
| 两个 World 的路径相同 | 身份依赖 World + canonical cwd；不能用 cwd 猜测 World。浏览器已覆盖两 World 同 `/workspace` 与文件隔离 |
| World 缺失、配置变更、断线 | 显式失败，绝不回退本地或另一容器。不要把本地同名目录当作备用 |
| 宿主重启或 helper 替换 | 用持久 binding 准备新 runtime；历史保留，旧进程和命令不自动恢复/重放 |
| 活跃 runtime 连接中断 | 仅有限宽限期内恢复相同 runtime/请求身份；超期失效，不使用新请求 ID 重放不确定命令 |
| 子 Agent / Web fork | 子 Agent 默认继承，已有 failed-commit 执行阻止；浏览器已验证普通 Web fork 的启动前绑定；子 Agent consumer 不在当前 preset 中。跨 World 是新 Session，不继承另一环境的临时句柄 |
| 远端 Git worktree 与新 Agent | 尚无自动链路。子 Agent 继承父绑定与 cwd，Web fork 沿用源 cwd；新 worktree 需登记同一 World 下的新 portable_workspace，并在启动前建立新 Session 绑定 |
| 非工具阶段读取、后台回调 | 必须以 Agent/owner 明确选择 World；缺少上下文不能假设默认 World。共享路由尚待全链验证 |
| 本地与远端 symlink、`..` 不同 | 必须远端 canonicalize；patched tool-fs 与 Bash 使用远端解析；本地 sandbox policy 未装配 |
| 本地平台与目标平台不同 | 远端可执行文件、shell、路径规则由目标决定；不能根据本地 OS 选择目标 Bash/PowerShell |
| 远端 environment | 只传明确 spec.env，不复制 process.env；SSH 配置可能带用户显式配置的行为，应准确披露而非声称绝对禁止 forwarding |
| tool output 文件/附件/file URL | World 路径不是本地 file URL；下载、预览、附件入远端需显式桥接，当前未提供通用桥接 |
| 同名 Session 引用 | 原生 session-reference 的 sameWorkspace 只比较 cwd，适配前关闭或明确不支持 |
| 权限与 sandbox | 使用 SSH 账户权限，workspace 不是 containment；本地 sandbox policy/runner 不能自动约束远端。审批上下文与强制执行能力必须分开说明 |

新增消费者必须按这些反例验收。详见 [阶段计划](../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md)。

## Git worktree：当前能力与缺口

已绑定的 subprocess provider 可以在远端执行 Git 命令，前提是目标安装 Git、仓库可用且账号有权限；当前没有 worktree 专用编排或验收。执行 `git worktree add` 只产生 Git 工作目录，不会自动注册 portable_workspace 或创建 Agent。

维护中 registry 的 `createInWorld` 可以登记一个已存在的远端目录；`startPortableWorkspaceSession` 可为该目录建立新绑定并创建独立 Session。Web 可登记已有远端目录并创建 Session；Git worktree 创建与登记尚未组成自动流程。普通子 Agent 的继承检查要求 cwd 和完整绑定与父级一致，不能仅传新 cwd 来实现 worktree 隔离。当前固定 DSH 基线的 Web fork 复制源 cwd；workflow 的 isolation 选项明确延期，也不能自动提供这项能力。

预期语义是同一 World、不同 canonical workspace，对应两个 portable_workspace。新 Agent 的执行上下文应在启动前绑定新目录；它是否保留父子关系、复制哪些对话上下文，以及失败重试和清理规则，留待后续定界。详见[待处理的 worktree 边缘情况](../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md#远端-worktree待处理)。
