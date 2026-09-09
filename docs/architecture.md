# 架构与 DeepSeek Harness 的关系

## 责任边界

DSH 是本地 Agent 宿主；dsh-remote 是它的远程执行与项目集成层。DSH 的模型路由、循环、Session JSONL、工具注册/过滤和委派保持原生实现。我们维护外部插件，以及解决 DSH 缺失接口的固定版本补丁。终态拓扑不要求模型或 Harness 迁到远程，也不把 workspace 当成安全沙箱。

```text
本地 DSH Web / Agent / Session
  → portable_workspace(World, workspace) 与持久绑定
  → DSH FS / subprocess 能力接口
  → 本地 World owner + remote providers
  → TypeScript client → system OpenSSH → Rust helper
                                      → 远端 workspace / 子进程 / PTY
```

## 原生概念与实现对应

| DSH 概念 | 本项目实现 | 所属目录与状态 |
| --- | --- | --- |
| Service Provider / runtime owner | ExecutionWorlds 管理 World 连接，FS 与 subprocess 共享同一 runtime | [world/ssh-world](../integrations/dsh/packages/world/ssh-world/)，已有 |
| FileSystem provider | resolve/stat/read/write/edit/stream，远程目标带 World 与 runtime 身份 | ssh-world/src/fs.ts，已有 |
| SubprocessRuntime provider | argv、cwd、env、pipe、信号、取消、PTY 与输出句柄 | ssh-world/src/subprocess.ts、terminal.ts，已有 |
| Tool Consumer | 复用原生 read/write/edit/search 和适配过的 shell/terminal 消费者 | remote Web preset 已装配文件/搜索/前台与后台 Bash及原生终端工具 |
| Agent preset / realm | standing preset 的隔离组让 routers 与消费者看到同一服务实例；不是每个 Agent 重注册工具 | routing.ts 及集成测试，已有 |
| Agent / Session | Session ID → binding → World；Agents 由 DSH 创建和恢复 | bindings.ts、worlds.ts，已有 |
| Workspace / portable_workspace | portable_workspace 是 World × 远端 canonical workspace，成员关联到原生 Session | [portable_workspace plugin](../integrations/dsh/packages/workspace/portable-workspace/)，持久 registry 与 Web UI |
| Tool allow/deny | 由 DSH 原生过滤决定可调用工具，不用于选择本地/远端 | 本项目验证继承，不复制过滤引擎 |
| Jobs / terminal ownership | 原生 owner-aware 服务管理 Session 的任务；helper 管理底层进程句柄 | jobs 创建/查询/取消与 World 隔离已有 browser/SSH 验收；terminal 创建/读写/隔离也已验收 |
| Approval | 外部审批能力使用 World、cwd、操作事实 | 已暴露执行上下文；完整审批策略不由 helper 实现 |

`runtime/client/` 只认识协议，`runtime/ssh/` 只认识连接、安装与 runtime，`runtime/helper/` 只实现文件和进程。它们不认识 DSH Agent、portable_workspace、skills 或工具名称。

这里的 client 与 ssh 是本仓库的私有 npm packages，均用 TypeScript 编写，运行在本地 Node.js；它们不是 DSH 上游的 packages。Rust helper 是远端协议服务端。三者统一归入 `runtime/`，表示独立执行层，不表示全部代码都是原生二进制。DSH plugin 通过这些库接入 helper。

## 身份与生命周期

World catalog 描述环境；portable_workspace 选择该环境中的目录。当前 v1 `WorldDefinition` 同时包含 SSH 坐标与 cwd，是具体执行绑定，不能直接当成不含 workspace 的 catalog 条目。portable_workspace registry 为每个组合生成具体 binding ID，保留 v1 数据含义。

Session 的持久绑定不可改向。恢复以该绑定为权威，不以当前 UI 选择、同名路径或 SSH 连接是否存在为依据。子 Agent 继承绑定，沿持久 parent lineage 找到顶层 portable_workspace；逐级校验 cwd 和完整 binding，冷恢复可准备 World，但不会把 child 添加为顶层成员。原生 continuation 保留 child Session 与工具过滤。跨 World 使用独立 Session 和显式协作能力，不在现有 Agent 内偷偷切换环境。

World 身份、SSH 连接、helper runtime epoch、process ID 是不同层次。同一个活跃 runtime 可在有限宽限期内重连；宿主重启准备新 runtime 不恢复旧句柄，也不重放旧命令。见 [Session bindings](reference/session-bindings.md)。

## 补丁与新插件的分工

[series.json](../integrations/dsh/patches/series.json) 是固定上游 revision、已应用补丁及摘要的唯一来源。当前补丁涉及 **9 个原生包**；编译依赖闭包不等于修改这些依赖。

| 原生包（省略 @deepseek-ai/） | 补丁职责 |
| --- | --- |
| dsh-api-session-controller | 创建/接管/恢复/fork 前等待异步准入；图片读取接受显式 Session FS resolver；保留无适配器时的原生本地行为 |
| dsh-api-workspace-controller | 接受可选 registry feed；继续复用原生 Remote、client store 与 rename/delete/archive/order 命令 |
| dsh-tool-bash | 接受可选 workdir resolver；远端 profile 使用 Agent 所属 FS 解析，失败不回退宿主 |
| dsh-agent-instructions | 非工具生命周期通过显式 Agent environment 选择 FS 和 instruction home |
| dsh-skill / dsh-tool-skill | lookup 和缓存携带 Session 身份；可关闭 catalog 缓存；原生工具传播身份 |
| dsh-api-workspace-files | 文件读取、目录列表与变更通知接受 Agent FS 和 workspace root |
| dsh-client-ui-chat | 图片 URL 携带渲染所属 Session；文件链接通过该 Session 的远端 stat 解析后生成资源 URL |
| dsh-tool-fs | 处理 parent traversal 前通过已注入 FS 解析 cwd；不使用宿主同名目录 |

`packages/bundle/remote/src/index.ts` 是本地服务总装配入口，按依赖顺序挂载 World、同步服务、registry 和各消费者；overlay/preset 负责原生服务与工具域装配。`packages/workspace/portable-workspace` 聚合 registry、API/feed、浏览器导航、准入和文件适配。

外部 `portable_workspace` plugin 替换原生 Workspace registry 与 UI/navigation，新增 World-explicit 创建 Remote 和持久状态 feed；`session-admission` 负责绑定校验与准备；`ssh-world` 负责具体能力和路由。它们复用 DSH 的 Agent/Session、对话、工具注册与执行，不复制模型循环。

remote profile 将 FS、subprocess、shell 和 workdir resolver 放入同一 preset 隔离域，只发布 `remote` preset。连接器和 Session/control state 留在宿主。feed 与 Remote namespace 有独立激活边界，必须先于依赖它们的 controller/UI 可见，不能依赖 Loader 的偶然启动顺序。

交付为官方 DSH 加标准 bundle，开发者和用户共用 `dsh plugin add` 与官方启动命令。构建时仅编译 9 个兼容包与我们的插件；bundle overlay 禁用原生控制器／skill registry，按包内相对路径插入兼容实现，远端工具在 agent preset 内加载。兼容包间的运行时引用在构建期指向同一份包内文件；ui-chat 的浏览器模块从补丁源码单独构建，保留官方模块身份；其余服务与 Web 前端使用官方 npm 产物。

兼容目录保留原生 package、client factory 和 Typert 身份，DSH 按插件文件的最近 package.json 发现浏览器模块及 inventory。普通依赖由官方 profile fallback 解析，不使用 Node 解析 hook、不改写官方安装。配置插件在兼容服务激活前校验已验收的 DSH 版本。具体见 [安装](install.md)。

远端 instructions 和 skill provider 已接入，选择性部署及 exec 边界见 [Skills](skills.md)。`file-references` plugin 通过显式 Agent owner 扫描远端目录，提供原生文件引用候选；不读取宿主同名目录。
## 目录所有权

- `runtime/`：DSH 无关的 Rust helper 与 TypeScript client/SSH 库；两个 npm workspace 使用显式路径，不把 Rust crate 当成 npm 包。
- `integrations/dsh/packages/{subsystem}/{module}/`：world/ssh-world、workspace/portable-workspace、skill/remote-skills、bundle/remote 四组源码模块，统一发行；小适配器保留为文件和独立 Cordis 入口。
- `integrations/dsh/shared/`：少量跨模块工具；不存 World/Session 领域逻辑。
- `integrations/dsh/patches/`：上游基线与有序补丁；不存上游完整源码或 node_modules。
- `integrations/dsh/packaging/extension/`：安装配置、宿主 overlay 和 Agent preset，源码布局对应发行布局。
- `integrations/dsh/tests/integration/`：直接复用维护中的 registry，保留原生宿主缺口负例；低层 SSH 发行清单与说明归 tests/packaging。
- `integrations/dsh/tests/`、`scripts/`、`packaging/`：宿主兼容验证和发行适配；通用 client/SSH 测试归入 runtime/tests/。
- `docs/`：稳定的用户/维护者说明；`.agents/notes/`：计划、取舍、实验和按时间记录的证据。

`terminal` plugin 将原生 BashTerminalBackend 的创建转发给 Agent 所属远端 subprocess，保留原生 owner/关闭生命周期。`account-policy` 复用原生 policy 投影，固定为 SSH 账户权限；其他 sandbox mode 明确拒绝。两者不新增上游补丁。

`file-preview` 在工具调度之外显式解析 Session/Agent 所属 World。workspaceFiles 的目录树和文本预览限定在 portable_workspace 根；图片接口保留 SSH 账户可读绝对路径的语义，但必须携带 Session，不能读取宿主同名文件。变更通知用带 World/runtime 的 FS target 过滤，不以文件名去重或匹配。
