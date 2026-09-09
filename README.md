# dsh-remote

dsh-remote 为 DeepSeek Harness（DSH）提供 Remote Execution World：模型调用、Agent 循环、对话历史和 Web 控制面留在本地，项目文件、搜索和进程在选定 SSH 主机或容器中执行。项目身份是 **World × Workspace**，Session 固定绑定该项目；连接失败不会切回本地。

已有 DSH，运行一条命令安装扩展：

```sh
dsh plugin --profile web add https://github.com/aur3l14no/dsh-remote/releases/latest/download/dsh-remote-extension.tgz
```

启动 DSH，点击 **Connect to Host**，选择 SSH alias 或输入 `user@host`，再打开远端文件夹。运行时会自动下载、部署和复用。连接使用已有 OpenSSH 公钥认证和 `known_hosts`；请先确保终端中的 `ssh <host>` 可正常连接。

当前兼容 DSH **0.1.5-alpha.1**、Node.js **24.19+**；自动部署支持 Linux x86_64（glibc 2.36+）远端。

支持 World/目录选择、Session 创建/fork/冷恢复、远端文件与搜索、前台/后台 Bash、jobs、原生子 Agent 和终端工具、文件预览，以及远端项目指令和 Skills。网络连接器仍在宿主；完整远端 sandbox、附件桥接和自动 worktree 尚未提供。完整契约见[执行边界](docs/execution-boundaries.md)，不应将默认 DSH 工具全集视为远程兼容。

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
