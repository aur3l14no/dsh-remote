# 跨 World 子 Agent 委派

从本机 Workspace 的 Session 发起跨 World 工作。目标须先在 `worlds.json` 声明；工具不会扫描网络或导入 SSH config 中的所有 alias。

1. `list_worlds(pattern?)` 返回已配置 World 的 `id`、名称、类型和已登记 Workspace。pattern 按 ID 或名称匹配。
2. `prepare_workspace(world_id, path?)` 接收 World ID，校验并登记已有绝对目录。SSH 省略 path 时创建私有 `/tmp/dsh-workspace.*` 目录；准备可能安装 helper/rg。返回 `executionEnvironment`，其值是 Workspace ID。
3. 将 `executionEnvironment` 传给原生 `subagent.execution_environment`，并描述任务。Team、消息、完成通知及续接由 DSH 管理。

模型上下文的 Execution World 提供当前 `world`、`workspace`、`kind` 和 `cwd`。文件和命令工具自动使用会话绑定，不需要传 World ID。其他目标通过 `list_worlds` 查询；显示名称、World ID 和 Workspace ID 不可混用。

`prepare_workspace` 仅允许本机会话调用。新 child 的显式执行环境不改变父会话绑定；省略参数时继承父级。冷续接使用保存的绑定，目标失效时明确失败。临时 Workspace 和绑定保留供续接，结束 child 不自动删除目录。

具体工作由现有工具或 skill 编排，例如读取系统信息、运行项目测试、汇总并生成 HTML，再用原生 `present` 展示。普通子 Agent 不因任务描述包含“只读”就自动获得强制工具过滤或 OS 沙箱；执行权限遵循目标会话的实际策略。
