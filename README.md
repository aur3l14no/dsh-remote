# dsh-remote (experimental)

[![Tested with DSH 0.1.5-alpha.1](https://img.shields.io/badge/Tested_with_DSH-0.1.5--alpha.1-blue?style=flat)](docs/upstream-dependencies.md)

为 DeepSeek Harness（DSH）提供远程工作区。模型调用、对话历史和 Web 界面留在本地，项目文件、搜索和命令在选定的 SSH 主机或容器中执行。

## 快速开始

远端要求：**Linux x86_64（glibc 2.36+）**，并已配置 OpenSSH 公钥认证。请先确保终端中的 `ssh <host>` 可正常连接；扩展复用已有 SSH 配置和 `known_hosts`。

已有 DSH，运行一条命令安装扩展：

```sh
dsh plugin --profile web add https://github.com/aur3l14no/dsh-remote/releases/latest/download/dsh-remote-extension.tgz
```

启动 DSH，点击 **Connect to Host**，选择 SSH alias 或输入 `user@host`，再打开远端文件夹。所需运行组件会自动下载并通过 SSH 安装到远端，后续连接会复用已有安装。

## 能力与边界

- 远端文件读写、搜索与预览，以及项目指令和 Skills。
- 前台与后台 Bash、jobs、原生子 Agent 和终端工具。
- World 与目录选择、Session 创建、fork 和重启后恢复。Session 固定绑定 **World × Workspace**，连接失败不会切回本地。

网络连接器仍在本地运行。完整远端 sandbox、附件桥接和自动 worktree 尚未提供；默认 DSH 工具并非全部兼容远端。完整说明见[执行边界](docs/execution-boundaries.md)。

## 开发

```sh
npm ci
(cd runtime/helper && cargo build --locked)
npm run check
npm test
```

`runtime/` 是 DSH 无关的 helper、协议客户端与 SSH 库；`integrations/dsh/` 维护插件、补丁、装配和测试。目录职责见[架构](docs/architecture.md)，工具链、生成产物与聚焦检查见[开发指南](docs/development.md)。

## 文档入口

| 任务 | 文档 |
| --- | --- |
| 配置项目指令与同步 Skills | [Skills](docs/skills.md) |
| 理解执行位置与权限 | [执行边界](docs/execution-boundaries.md) |
| 维护架构与第三方消费者 | [架构](docs/architecture.md)、[插件兼容](docs/plugin-compatibility.md) |
| 升级 DSH 或制作发行包 | [上游依赖](docs/upstream-dependencies.md)、[发行](docs/release.md) |
| 查询底层契约 | [helper 协议](docs/reference/helper-api.md)、[bootstrap](docs/reference/bootstrap.md)、[Session bindings](docs/reference/session-bindings.md) |
| 查看未完成工作和历史证据 | [当前计划](.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md)、[Notes](.agents/notes/README.md) |

[MIT License](LICENSE)
