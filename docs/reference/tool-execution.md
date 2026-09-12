# 单次工具执行环境

Session 的 Workspace 是默认执行环境。支持此能力的工具可显式传入 `execution_environment`，临时到已配置 World 的现有目录执行，下一次省略该参数仍使用 Session 默认环境。

```json
{
  "command": "pwd; git status --short",
  "description": "检查另一个 World 的仓库",
  "execution_environment": { "world": "build", "cwd": "/projects/example" }
}
```

`world` 是 `list_worlds` 返回的 World ID，`local` 表示 DSH 宿主。`cwd` 必须是目标 World 上已有的绝对目录；路径由目标 FS 解析。无需先登记 Workspace。World 缺失、配置不匹配、目录不存在或连接失败都明确报错，不切回本机。

| 工具 | 目标选择及路径 |
| --- | --- |
| `bash` | 接受 execution_environment；已有 workdir 在选定 cwd 下解析 |
| `read`、`write`、`edit`、`read_image` | 接受 execution_environment；file_path 在选定 cwd 下解析 |
| `glob`、`grep` | 接受 execution_environment；搜索使用目标文件系统／进程与 cwd |
| `terminal_open` | 接受 execution_environment；已有 cwd 参数在选定目录下解析 |
| `present` | 接受 execution_environment；文件引用保留来源，供之后的浏览器预览使用 |
| `job_output`、`job_kill` | 按 job_id 继承资源创建时的环境，不接受重新选目标 |
| `terminal_read`、`terminal_send`、`terminal_signal`、`terminal_close` | 按 sessionId 继承终端环境，不接受重新选目标 |

列表、Session 管理、连接器和其他未声明此能力的工具不会通过 execution_environment 获得执行路由。额外参数是否允许由工具 schema 决定：DSH 的 defineTool 默认使用开放对象 schema，未声明字段可被接受，但不会触发路由；路由层不替其他工具校验或解释参数。原生 `subagent` 和 `spawn_teammate` 的同名参数使用独立的 Workspace 绑定接口：接收 `prepare_workspace` 返回的 Workspace ID 字符串，为新成员选择持续使用的环境，不接受本页的 `{world,cwd}` 对象。工具声明自己的参数契约，通用执行路由不会重新解释成员创建参数。

## 一次解析，共用上下文

0012 中的工具定义声明访问种类、路径／目录参数，以及创建或引用的资源字段。`toolEnvironment` 插件提供参数 schema，并在原生 `tools/execute` 周围准备不可变调用环境。FS、subprocess、shell、权限和 `executionWorldContext` 共用这个环境；路由不维护工具名称白名单。并发调用各有异步上下文，后台操作持有具体 provider／资源句柄。

工具参数原样写入原生 tool/call。审批仍使用原生 approval/request，callId 关联完整工具调用，实际 World 事实来自当前调用环境。没有增加事件格式，也没有替换原生工具运行时或审批回答者。

权限模式仍属于发起 Session。同一 World 的免审批写入范围仍是原绑定的 Workspace，临时 cwd 不扩大它；另一个 World 的写入需要审批（Full access 除外）。read 类工具免去 SSH 工具审批。SSH 命令在受限模式下逐次审批，本机目标继续使用原生 sandbox。权限变更使等待中的审批失效。

job/terminal 的后续调用由声明的资源字段取回环境，原生服务继续负责 Session owner 检查、查询、取消与关闭。宿主重启不恢复旧进程句柄。

## 不改变的 Session 状态

临时调用不修改 Session header、持久 binding、工作区成员或时间戳，不改变 UI 当前 Workspace，也不重新加载 Session 指令或 Skills。需要持续在另一项目工作并加载其项目指令时，应创建或委派绑定该项目的 Session。

附件仍按发起 Session 存储。read_image 从本次目标读取，再交给原生图片处理／Session 附件流程；它不会切换整个 Session 的附件后端。

## 文件结果与延迟预览

显式环境下的 write/edit 结果与 present 交付保存带来源的文件引用。它包含 World ID、canonical 路径、调用目录和环境指纹，不包含 SSH 凭据。工具定义通过统一环境接口提供文件环境 metadata；工具详情的文件链接、write/edit 的输出链接与 present 交付都据此打开实际目标。metadata 使用原生结果载体，浏览器不从参数名猜 World。工具尚未完成时不开放详情中的文件链接；显示名称省略机器使用的查询字段。

预览先验证查看 Session，再准备引用的 World 并校验配置指纹；World 被移除或重新配置时失败，不打开默认 Workspace 的同名文件。引用是文件预览地址，后续修改仍通过对应工具的 execution_environment 和 file_path 完成。
