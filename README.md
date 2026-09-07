# dsh-remote

dsh-remote 为 DeepSeek Harness（DSH）提供 Execution World：模型调用、Agent 循环、对话历史和 Web 控制面留在本地，项目文件、搜索和进程在选定机器或容器中执行。项目身份是 **World × canonical workspace**，Session 固定绑定该项目；连接失败不会切回本地。

## 架构

```text
runtime/                        与 DSH 无关的执行层
  helper/                       Rust：远端文件、进程、PTY 与协议服务
  client/                       TypeScript：本地协议客户端
  ssh/                          TypeScript：本地 OpenSSH 连接与 bootstrap
  tests/                        通用 client / SSH 验证
  scripts/                      runtime 产物准备与上传
integrations/dsh/
  plugins/ssh-world/             DSH World owner、FS/subprocess providers、路由
  plugins/session-admission/     patched host 的 Session 准入适配器
  plugins/portable_workspace/    持久 registry、Web API/feed 与浏览器导航
  patches/                      固定上游基线及补丁序列
  profiles/                     DSH 应用装配约定
  experiments/portable_workspace/    unchanged-source 缺口与显式入口实验
  tests/                        DSH binding 与集成验证
  scripts/                      DSH 类型检查、构建、打包及验收入口
  packaging/                    SSH plugin 发行清单
```

DSH 集成采用下游补丁与外部插件配合：补丁提供缺失的准备/解析接口，插件实现 World、portable_workspace 和远程能力。DSH 保留 Agent、Session、工具过滤、委派和通用对话。具体对应见 [架构与 DSH 关系](docs/architecture.md)。

## 当前可用范围

Rust helper 0.1.1、协议客户端、SSH bootstrap、FS/subprocess/PTY providers 与持久 Session 绑定已有实现。SSH 后可选进入已有 Podman 容器。

受限的 remote Web profile 通过真实 DSH Web、Playwright Chromium 与两个 Linux/SSH World 验收：显式选择 World 和目录、Session 创建/fork、远端读写与命令、宿主冷启动恢复和取消。宿主 Web Search 使用原生 DeepSeek provider 接入受控 HTTP 服务验证执行边界；不代表外部搜索服务可用性或真实模型质量验收。

目前是固定上游的源码装配入口，尚未作为独立 Web npm 发行包发布。remote preset 仅装配已验证的文件、搜索、前台 Bash 和 Web 工具；项目 instructions/skills、文件补全、后台 jobs 和完整远程 sandbox 尚未纳入。不能将默认 DSH Web 的工具全集视为远程兼容。

这不是一个把所有工具都搬到远程的系统。本地连接器与远程项目工具需要不同能力入口；本地 skill 的脚本不会自动同步，也不会自动在本地执行。详见 [执行边界与 edge cases](docs/execution-boundaries.md)。

## 开发与文档

```sh
cargo build --locked
npm run check
npm test
```

Cargo workspace 保留根目录构建命令和 `target/` 产物路径。环境要求、DSH 基线检查、集成和打包命令见 [开发指南](docs/development.md)。

- [架构与 DSH 对应](docs/architecture.md)：稳定的责任和接口边界。
- [执行边界](docs/execution-boundaries.md)：本地/远端、skills、凭据和未支持能力。
- [helper 协议](docs/reference/helper-api.md)、[bootstrap](docs/reference/bootstrap.md)、[Session bindings](docs/reference/session-bindings.md)：实现契约。
- [当前阶段计划](.agents/notes/proposed/integration/2026-09-07-world-portable_workspace-web.md)：顺序、未决项和验收门槛。
- [Agent Notes](.agents/notes/README.md)：决策、实验和历史证据；不作为已交付功能说明。
