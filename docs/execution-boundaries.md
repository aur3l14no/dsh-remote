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

[routing.ts](../integrations/dsh/packages/world/ssh-world/src/routing.ts) 在缺失路由时抛错；[worlds.ts](../integrations/dsh/packages/world/ssh-world/src/worlds.ts) 检查持久绑定、Agent 活跃绑定、cwd 与 runtime 状态。新增 session-admission 适配器通过宿主补丁在普通 Session 创建、恢复、接管和 fork 前执行准入；这条链路独立于工具调用的 ALS。工具调度之外的调用可以明确使用 `executionWorlds.forAgent(agent)`，instructions 和 skill lookup 已有独立身份入口；当前未自动覆盖全部初始化、上传和后台消费者。

目前 **没有** 自动分类全部工具的黑白名单，也没有可用的通用 local-shell 工具。以下机制必须区分：

| 机制 | 已有行为 | 不代表什么 |
| --- | --- | --- |
| DSH tool allow/deny | 原生工具可见性与调用权限、子 Agent 过滤 | 不决定工具的执行主机 |
| preset/profile 装配 | remote preset 显式装配文件/搜索/前台 Bash/Web/skill 工具和项目 instructions | 不包含默认工具全集，也没有自动插件兼容检测 |
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
| workspace Shell、PTY、进程、信号与输出 | provider 传 argv/cwd/env 到远端 helper | 前台/后台 Bash、jobs 查询与取消已有浏览器验收；原生终端工具已装配，独立终端面板未提供 |
| HTTPS web search / 连接器请求 | 若装配的是本地网络客户端，请求从本地发出 | remote preset 装配原生 Web 工具和宿主 DeepSeek search provider；受控端点和真实外部搜索已验收 |
| Shell 中 `curl`/搜索 CLI | 远端 Shell | 即使目的也是网络搜索，也不会按关键词切成本地 |
| 上传附件的持久存储 | 本地 DSH attachment store | 可留本地；远程工具读取需显式 transfer，尚未实现 |
| 本地用户/内置 skill 内容 | 可以通过独立本地 provider 提供文本 | 不自动获得本地执行权；选定内容可显式部署到远端；未启用宿主默认 skill 扫描 |
| 项目 AGENTS.md / 项目 skill / @文件补全 | 应从绑定 World 读取 | instruction、skill 扫描及文件补全均通过显式 Session/Agent 选择远端 provider |

“所有 workspace 操作走远端”是受支持装配必须满足的契约，不是当前对任意 DSH 插件都已强制成立的保证。

Web Search 的故障/取消和双 Session 并发仍待专项验收，测试要求见[当前计划](../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md#web-search-重点验收)。

## Skills 与数据传递

Skill 提供说明和资源，不选择执行主机。远程 Shell 收到本地脚本路径时仍在绑定 World 执行；不会临时复制依赖、改写命令或失败后转到宿主。选定内容的部署、发现和同步统一见 [Skills](skills.md)。

本地 API 与远端项目数据组合时，明确执行“远端读取/导出 → 授权的数据传递 → 本地 API”，写回同样显式。连接器使用宿主凭据；通用 host shell 未提供，skill 来源不能授予额外执行权。

## 必须保持的边缘行为

| 情形 | 行为与实现状态 |
| --- | --- |
| 两个 World 的路径相同 | 身份依赖 World + canonical cwd；不能用 cwd 猜测 World。浏览器已覆盖两 World 同 `/workspace` 与文件隔离 |
| World 缺失、配置变更、断线 | 显式失败，绝不回退本地或另一容器。不要把本地同名目录当作备用 |
| 宿主重启或 helper 替换 | 用持久 binding 准备新 runtime；历史保留，旧进程和命令不自动恢复/重放 |
| 活跃 runtime 连接中断 | 仅有限宽限期内恢复相同 runtime/请求身份；超期失效，不使用新请求 ID 重放不确定命令 |
| 子 Agent / Web fork | 子 Agent 默认继承，已有 failed-commit 执行阻止；浏览器已验证普通 Web fork 的启动前绑定；子 Agent 创建、继承指令/skill、宿主重启后的 continuation、工具过滤与损坏绑定拒绝均已验收。跨 World 是新 Session，不继承另一环境的临时句柄 |
| 远端 Git worktree 与新 Agent | 尚无自动链路。子 Agent 继承父绑定与 cwd，Web fork 沿用源 cwd；新 worktree 需登记同一 World 下的新 portable_workspace，并在启动前建立新 Session 绑定 |
| 非工具阶段读取、后台回调 | 必须以 Agent/owner 明确选择 World；缺少上下文不能假设默认 World。已验证 instruction、skill、文件补全和 jobs；未装配消费者仍需单独验证 |
| 本地与远端 symlink、`..` 不同 | 必须远端 canonicalize；patched tool-fs 与 Bash 使用远端解析；account-policy 固定 SSH 账户权限，不声称路径 containment |
| 本地平台与目标平台不同 | 远端可执行文件、shell、路径规则由目标决定；不能根据本地 OS 选择目标 Bash/PowerShell |
| 远端 environment | 只传明确 spec.env，不复制 process.env；SSH 配置可能带用户显式配置的行为，应准确披露而非声称绝对禁止 forwarding |
| tool output 文件/附件/file URL | 原生 Sidebar 文本预览和目录树按 Session 选择远端 FS，并限制在 workspace 根；Markdown 绝对路径图片按 Session 读取远端账户可读文件。缺失身份拒绝；附件上传/下载及附件入远端仍未提供通用桥接 |
| 同名 Session 引用 | 原生 session-reference 的 sameWorkspace 只比较 cwd，适配前关闭或明确不支持 |
| 权限与 sandbox | 使用 SSH 账户权限，workspace 不是 containment；本地 sandbox policy/runner 不能自动约束远端。只允许 danger-full-access，其他模式在写入前拒绝；原生工具名过滤不等于能力隔离（允许 Bash 就仍可执行命令）。remote overlay 禁用原生 permission/UI，不承诺逐次审批界面；暴露审批事实不等于强制执行能力 |

新增消费者必须按这些反例验收。详见 [阶段计划](../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md)。

## Git worktree：当前能力与缺口

远端 subprocess 可运行目标已有的 Git；registry 可登记已有目录并为其创建独立 Session。两者尚未组成自动 worktree 流程。child 继承父绑定/cwd，Web fork 也不新建目录；隔离子 Agent、创建失败清理和上下文复制规则见[后续计划](../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md#远端-worktree待处理)。

## 文件预览

文本预览、目录列表和文件变更通知使用显式 Agent environment，不依赖 tools/execute 的 ALS。workspace root 来自该 Session 的 portable_workspace，不使用账户权限策略中的 `/`。路径先在远端解析；最终条目为 symlink 或解析后越根时拒绝；workspace 仍不限制 Shell 的 SSH 账户权限。

图片请求 `/api/file?path=...&sessionId=...` 按持久 Session membership/binding 准备 World，支持冷会话。身份缺失、绑定冲突或 World 不可用时失败，不根据浏览器当前选中项、同名 cwd 或宿主文件决定路由。图片保持官方绝对路径语义：可以读取 workspace 外但 SSH 账户有权读取的普通文件，受图片字节上限约束。它不提供任意 URL 代理或本地文件能力。

文件预览不提供 OS 文件 watcher；变更提示来自 Agent FS observation，外部编辑需手动刷新。旧 helper 缺少范围读取 capability 时提示更新，不用整文件下载模拟范围读取。
