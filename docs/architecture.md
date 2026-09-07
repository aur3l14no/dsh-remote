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
| Service Provider / runtime owner | ExecutionWorlds 管理 World 连接，FS 与 subprocess 共享同一 runtime | [plugins/ssh-world](../integrations/dsh/plugins/ssh-world/)，已有 |
| FileSystem provider | resolve/stat/read/write/edit/stream，远程目标带 World 与 runtime 身份 | ssh-world/src/fs.ts，已有 |
| SubprocessRuntime provider | argv、cwd、env、pipe、信号、取消、PTY 与输出句柄 | ssh-world/src/subprocess.ts、terminal.ts，已有 |
| Tool Consumer | 复用原生 read/write/edit/search 和适配过的 shell/terminal 消费者 | remote Web preset 已装配文件/搜索/前台 Bash；PTY 仍为底层能力 |
| Agent preset / realm | standing preset 的隔离组让 routers 与消费者看到同一服务实例；不是每个 Agent 重注册工具 | routing.ts 及集成测试，已有 |
| Agent / Session | Session ID → binding → World；Agents 由 DSH 创建和恢复 | bindings.ts、worlds.ts，已有 |
| Workspace / portable_workspace | portable_workspace 是 World × 远端 canonical workspace，成员关联到原生 Session | [portable_workspace plugin](../integrations/dsh/plugins/portable_workspace/)，持久 registry 与 Web UI |
| Tool allow/deny | 由 DSH 原生过滤决定可调用工具，不用于选择本地/远端 | 本项目验证继承，不复制过滤引擎 |
| Jobs / terminal ownership | 原生 owner-aware 服务管理 Session 的任务；helper 管理底层进程句柄 | 集成 fixture；共享路由的非工具调用仍需验证 |
| Approval | 外部审批能力使用 World、cwd、操作事实 | 已暴露执行上下文；完整审批策略不由 helper 实现 |

`runtime/client/` 只认识协议，`runtime/ssh/` 只认识连接、安装与 runtime，`runtime/helper/` 只实现文件和进程。它们不认识 DSH Agent、portable_workspace、skills 或工具名称。

这里的 client 与 ssh 是本仓库的私有 npm packages，均用 TypeScript 编写，运行在本地 Node.js；它们不是 DSH 上游的 packages。Rust helper 是远端协议服务端。三者统一归入 `runtime/`，表示独立执行层，不表示全部代码都是原生二进制。DSH plugin 通过这些库接入 helper。

## 身份与生命周期

World catalog 描述环境；portable_workspace 选择该环境中的目录。当前 v1 `WorldDefinition` 同时包含 SSH 坐标与 cwd，是具体执行绑定，不能直接当成不含 workspace 的 catalog 条目。portable_workspace registry 为每个组合生成具体 binding ID，保留 v1 数据含义。

Session 的持久绑定不可改向。恢复以该绑定为权威，不以当前 UI 选择、同名路径或 SSH 连接是否存在为依据。子 Agent 默认继承；跨 World 使用独立 Session 和显式协作能力，不在现有 Agent 内偷偷切换环境。

World 身份、SSH 连接、helper runtime epoch、process ID 是不同层次。同一个活跃 runtime 可在有限宽限期内重连；宿主重启准备新 runtime 不恢复旧句柄，也不重放旧命令。见 [Session bindings](reference/session-bindings.md)。

## 补丁与新插件的分工

[series.json](../integrations/dsh/patches/series.json) 是固定上游 revision、已应用补丁及摘要的唯一来源。当前补丁涉及 **4 个原生包**；编译依赖闭包不等于修改这些依赖。

| 原生包（省略 @deepseek-ai/） | 补丁职责 |
| --- | --- |
| dsh-api-session-controller | 创建/接管/恢复/fork 前等待异步准入；保留无适配器时的原生本地行为 |
| dsh-api-workspace-controller | 接受可选 registry feed；继续复用原生 Remote、client store 与 rename/delete/archive/order 命令 |
| dsh-tool-bash | 接受可选 workdir resolver；远端 profile 使用 Agent 所属 FS 解析，失败不回退宿主 |
| dsh-tool-fs | 处理 parent traversal 前通过已注入 FS 解析 cwd；不使用宿主同名目录 |

外部 `portable_workspace` plugin 替换原生 Workspace registry 与 UI/navigation，新增 World-explicit 创建 Remote 和持久状态 feed；`session-admission` 负责绑定校验与准备；`ssh-world` 负责具体能力和路由。它们复用 DSH 的 Agent/Session、对话、工具注册与执行，不复制模型循环。

remote profile 将 FS、subprocess、shell 和 workdir resolver 放入同一 preset 隔离域，只发布 `remote` preset。连接器和 Session/control state 留在宿主。feed 与 Remote namespace 有独立激活边界，必须先于依赖它们的 controller/UI 可见，不能依赖 Loader 的偶然启动顺序。

当前 Web 插件由脚本输出到 `target/web-plugin`、`target/web-plugin-ui`，profile 的安装锚点位于 `target/web-profile`。宿主 DSH 依赖保留为外部包，浏览器使用上游 client module factory 协议。源码构建、包依赖装配与公开 npm 发行是不同验收层次。

项目 instructions、项目 skill 和 remote file-reference 的适配仍在[阶段计划](../.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md)中；它们没有作为当前 profile 能力发布。
## 目录所有权

- `runtime/`：DSH 无关的 Rust helper 与 TypeScript client/SSH 库；两个 npm workspace 使用显式路径，不把 Rust crate 当成 npm 包。
- `integrations/dsh/plugins/`：可装配的 DSH 运行时实现；ssh-world 有独立打包入口；session-admission 与 portable_workspace 用于固定 patched Web 源码装配。
- `integrations/dsh/patches/`：上游基线与有序补丁；不存上游完整源码或 node_modules。
- `integrations/dsh/profiles/`：宿主装配边界；仅在真实 Loader 验证后收录可运行 profile。
- `integrations/dsh/experiments/`：不随插件发行的可执行实验；portable_workspace 实验复用维护中的 registry，保留原生宿主的缺口负例。
- `integrations/dsh/tests/`、`scripts/`、`packaging/`：宿主兼容验证和发行适配；通用 client/SSH 测试归入 runtime/tests/。
- `docs/`：稳定的用户/维护者说明；`.agents/notes/`：计划、取舍、实验和按时间记录的证据。
