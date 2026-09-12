# Agent Teams

标准与 SSH preset 使用 rc.2 的 experimental Agent Teams。Agent runtime、成员目录、消息与任务板都留在 DSH 宿主；项目文件和进程由每个成员的 World binding 或单次工具环境路由。团队协调不连接另一台运行 Agent 的服务器。

## 创建成员

`spawn_teammate` 接受 `name`、`description`、`prompt`、可选的 `context: fresh | fork`。省略执行环境时继承 Lead Workspace。

要持续在另一 World 工作，先用 `prepare_workspace` 获得 Workspace ID，再传入 `spawn_teammate.execution_environment`（字符串）。这与文件／Bash 工具的 `{world,cwd}` 单次选择不同。显式选择只允许 fresh；fork 保留 Lead 的上下文和工作区。创建与冷续接复用原生子 Agent provider 和已有 binding 准入，不改变 Lead 的 Workspace。

## 协调和任务板

每个成员使用同一套九个工具：`spawn_teammate`、`list_agents`、`send_message`、`interrupt_agent`、`wait_agent`、`team_task_create`、`team_task_list`、`team_task_get`、`team_task_update`。只有 Lead 创建和中断 teammate；消息按成员名字或 `lead` 寻址。

任务、成员和消息记录持久保存在 Lead Session。任务更新携带 `expected_revision`，陈旧更新失败。`write_scopes` 仍是团队共享的相对路径提示，只提供重叠提醒，不决定目标 World、不授权文件访问，也不是文件锁；不同 World 的同名路径可能收到保守的重叠提示。执行权限继续由目标 provider 和发起成员的权限模式决定。

原生 `subagent` 保留一次性委派；`send_message`、`list_agents`、`interrupt_agent` 改由 Teams 管理团队成员，不再作为任意旧 continuable child 的全局控制工具。没有迁移旧子 Agent 或自动把历史 child 加入 roster。

## 浏览器

会话顶部的 Agent Team 打开成员列表和共享任务板，可以编辑任务并打开 teammate 会话。面板在打开、手动刷新和修改时读取快照；它不是实时 mailbox 时间线。普通子 Agent 导航仍由原生目录管理。

这是 experimental 功能，固定到与宿主一致的 rc.2。协调仍限一个 DSH 进程；成员共享任务板，但不要求项目 IO 都在宿主。停机和中断不会自动释放任务 owner。
