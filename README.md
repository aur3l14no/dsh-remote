# dsh-remote (experimental)

[![Tested with DSH 0.1.5-rc.2](https://img.shields.io/badge/Tested_with_DSH-0.1.5--rc.2-blue?style=flat)](docs/development/upstream-upgrades.md)

为 DeepSeek Harness（DSH）提供本机与 SSH 工作区。同一实例中选择执行环境，模型调用、对话历史和 Web 界面留在 DSH 宿主；项目文件、搜索和命令默认按会话绑定执行，也可为单次工具调用显式指定另一个 World 与目录。

## 快速开始

远端要求：**Linux x86_64（glibc 2.36+）**，并已配置 OpenSSH 公钥认证。请先确保终端中的 `ssh <host>` 可正常连接；扩展复用已有 SSH 配置和 `known_hosts`。

已有 DSH，运行一条命令安装扩展：

```sh
dsh plugin --profile web add https://github.com/aur3l14no/dsh-remote/releases/latest/download/dsh-remote-extension.tgz
```

本机工作区可直接在 **Choose workspace → This computer → Choose a folder…** 选择，无需 SSH 或 helper。“本机”是运行 DSH 服务的机器；本轮本机验收平台为 macOS。

使用 SSH 工作区时，在 `$DSH_HOME/remote/worlds.json` 中声明 World 和 Workspace（[配置示例](docs/reference/worlds.md)），在 Web 界面点击 **Reload worlds**，预览并确认应用。在 **New Session** 输入框上方选择工作区。所需运行组件会自动下载并通过 SSH 安装到远端，后续连接会复用已有安装。

## 能力与边界

- 本机原生文件、进程、Skills、权限与目录选择；与 SSH 工作区共用选择器。
- 远端文件读写、搜索与预览，以及项目指令和 Skills。
- 同一 DSH 进程内，同一 World 的多个 Workspace 共用一个 helper 和 SSH 数据连接，目录与资源清理各自独立。
- 前台与后台 Bash、jobs、原生子 Agent 和终端工具。
- 不切换 Workspace 的单次跨 World 文件与命令操作；[工具执行环境](docs/reference/tool-execution.md)。
- Experimental Agent Teams：宿主上的成员、消息与任务板，teammate 可绑定不同 World；[Teams](docs/reference/agent-teams.md)。
- 本机 leader 显式委派跨 World 原生 child；[跨 World 委派](docs/reference/cross-world-delegation.md)。
- World 与目录选择、Session 创建、fork 和重启后恢复。Session 固定绑定 **World × Workspace**，连接失败不会切回本地。

本机附件使用原生宿主存储；SSH 附件持久存储在 Session 绑定的远端，模型请求和预览按需读回，工具使用远端路径。网络连接器仍在本地运行。完整远端 sandbox 和自动 worktree 尚未提供；默认 DSH 工具并非全部兼容远端。功能与上游接点见[系统全景](docs/system-map.md)，附件限制和身份规则见[附件契约](docs/reference/workspace-io.md#上传附件)。

Web 侧边栏使用原生 New Session 控件；工作区区域提供 Reload worlds 与会话列表，卡片依次显示 World / Workspace、会话名称与目录。World 颜色、待选工作区和 Skills 来源在 [worlds.json](docs/reference/worlds.md) 中声明，也可由 Agent 协助编辑。

## 使用

- **更新配置或 Skills**：编辑 `worlds.json` 中的 World、Workspace 或 `skills` 来源后，点击 **Reload worlds**，核对预览，再选择 **Apply changes**。仅更新本地 skill 来源内容时也可手动重载；配置字段及部署规则见 [World 配置](docs/reference/worlds.md)和 [Skills](docs/reference/skills.md)。
- **临时到另一环境执行**：让 Agent 在指定 World 和绝对目录下读取文件或运行命令。支持的工具通过 `execution_environment: {world, cwd}` 选择目标，不切换当前会话；参数及权限规则见[工具执行环境](docs/reference/tool-execution.md)。
- **委派工作**：让本机会话的 Agent 查询已配置 World、准备目标目录，再创建子 Agent 或 teammate。准备结果是 Workspace ID，供创建工具的 `execution_environment` 字符串参数使用；见[跨 World 委派](docs/reference/cross-world-delegation.md)。持续协作使用 [Agent Teams](docs/reference/agent-teams.md)，在会话顶部打开 **Agent Team** 查看成员和任务板。

## 开发

`runtime/` 是 DSH 无关的 helper、协议客户端与 SSH 库；`integrations/dsh/` 维护插件、补丁、装配和测试。环境准备、检查、测试、升级和发布统一从[开发与验证](docs/development/README.md)进入。

## 文档入口

| 任务 | 文档 |
| --- | --- |
| 理解架构、功能边界与源码位置 | [系统全景](docs/system-map.md) |
| 查询配置与工具契约 | [World 配置](docs/reference/worlds.md)、[Skills](docs/reference/skills.md)、[工具执行环境](docs/reference/tool-execution.md)、[跨 World 委派](docs/reference/cross-world-delegation.md)、[Agent Teams](docs/reference/agent-teams.md) |
| 查询执行与存储契约 | [Session bindings](docs/reference/session-bindings.md)、[bootstrap](docs/reference/bootstrap.md)、[helper 协议](docs/reference/helper-api.md)、[文件预览与附件](docs/reference/workspace-io.md) |
| 开发、测试、IO 路由检查、升级与发布 | [开发与验证](docs/development/README.md) |
| 查看未完成工作和历史证据 | [当前计划](.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md)、[Notes](.agents/notes/README.md) |

[MIT License](LICENSE)
