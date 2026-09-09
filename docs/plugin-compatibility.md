# 第三方插件与远端 World

DSH 插件能被 Loader 加载，不等于能在 remote profile 正确执行。当前没有任意插件自动兼容检查，也没有公开稳定的 World SDK；下面是将消费者适配进本仓库装配的契约。适配源码放在 `integrations/dsh/`，通过安装态验收后才列为支持。

## 按操作选择能力

| 操作 | 执行地点与接口 | 不兼容的假设 |
| --- | --- | --- |
| 模型工具中的项目读写 / 搜索 / 进程 | 当前 tool execution 的 Session → binding → World；使用同 preset 中的 ctx.fs / ctx.subprocess | 直接 node:fs、execFile、spawn；用宿主 cwd、路径前缀或工具名选择环境 |
| 初始化、后台、API 或预览中的项目操作 | 显式携带所属 Agent，通过 executionWorlds.forAgent(agent) 获取 provider；按现有 admission 准备环境 | 假定 tools/execute 的 AsyncLocalStorage 总是存在；用当前 UI 选择替代请求所属 Session |
| 连接器 / Web API | 宿主网络客户端与宿主凭据；只发送明确需要的查询或数据 | 为连接器启用通用本地 shell，或失败后改用远端 CLI |
| 配置、binding、Session 历史 | 宿主控制状态；插件自己的明确存储位置 | 因为 workspace 在远端，就把所有文件操作或凭据一起搬过去 |
| 项目 instructions / skills | 带 Session 身份的远端发现；需部署的本地内容走显式同步 | 把 skill 所在位置当成命令执行位置；偷偷复制依赖或改写脚本路径 |

工具调用中 `ctx.fs` / `ctx.subprocess` 路由已经由 remote preset 提供。工具之外的入口参考 [file-preview.ts](../integrations/dsh/packages/workspace/portable-workspace/src/file-preview.ts) 和 [admission.ts](../integrations/dsh/packages/workspace/portable-workspace/src/admission.ts)，不要另写一套 Session→World 推断。执行上下文投影见 [executionWorldContext](../integrations/dsh/packages/world/ssh-world/src/routing.ts)，用于模型和审批事实，不包含 SSH 凭据。

异步任务捕获具体 owner/provider/进程句柄；不要在任务完成回调中按新的 UI 选择重新查找 World。缺失、冲突、损坏 binding 或 runtime 变化必须明确失败；断线不能切回本地。

## Git / worktree 的例子

一个本地 worktree 插件即使使用安全的 argv + execFile，仍然是在宿主执行 Git。适配时应通过所属 World 的 subprocess 运行 Git，用同一 FS 解析目录；新目录要登记为该 World 下新的 portable_workspace，再创建绑定的新 Session。

当前尚未实现完整 worktree 创建、失败清理或隔离子 Agent。普通 child 继承原 binding，不能仅修改 cwd 获得另一工作区。现有 registry 能接收已存在目录，不等于已有 worktree 产品能力。

## 最低验收证据

- 宿主与两个 World 都有同名路径、不同内容；实际读写/进程结果只能出现在选定 World。
- 两 Session 并发及后台完成回调不串线；停止 World、丢失 binding 后明确拒绝，宿主文件无副作用。
- 冷启动和 fork/child（消费者使用时）保持身份；控制状态留宿主，连接器凭据不进入远端 env 或产物。
- 涉及 UI/API 的消费者使用官方 CLI 安装态验证，不能只测源码函数。补丁变更另跑 unchanged-source 与 patched-host gates。

边界细节见 [执行边界](execution-boundaries.md)，上游变化风险见 [上游依赖](upstream-dependencies.md)。
