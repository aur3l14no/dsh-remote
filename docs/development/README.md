# 开发与验证

需要 Rust 1.85+、Node.js 24+。命令从仓库根执行，Cargo 命令在 `runtime/helper/` 执行；项目依赖使用 npm 与 `package-lock.json`。

## 本目录

- 本页：开发环境、检查与测试入口、产物清理和离线维护。
- [上游升级](upstream-upgrades.md)：接口风险、补丁移除条件和升级顺序。
- [发行](release.md)：候选产物、验收来源和发布流程。

## 统一开发入口

```sh
npm ci
npm run check:runtime
npm test
```

DSH 检查还需准备 [series.json](../../integrations/dsh/patches/series.json) 固定 revision 的干净源码，放在 `.build/dsh/upstream` 或用 `DSH_SOURCE` 指定，然后安装官方依赖：

```sh
node integrations/dsh/scripts/prepare-official.mjs
```

| 入口 | 用途 |
| --- | --- |
| `npm run check:runtime` | Rust 与 runtime TS 静态检查，无需 DSH 安装 |
| `npm test` | 构建 helper 并运行快速行为测试，无需外部服务 |
| `npm run check` | 自有代码、原版 DSH 接口与补丁宿主的静态检查 |
| `npm run test-integration` | 装配、独立包与补丁行为；设置 `DSH_TEST_RG` 为本机 ripgrep 路径 |
| `npm run test-e2e` | 安装态、浏览器、本机与双 Linux/SSH 验收；需要 Docker Compose、OpenSSH 和 Chromium |
| `npm run package` | 构建扩展 tarball，不代替行为验收 |

`just` 提供同名入口。按改动范围选择检查；纯文档只检查链接和事实。

## 上游兼容检查（升级或补丁变更）

保留两类独立 gate：unchanged-source 验证原版 DSH 接口，patched-host 验证下游补丁；安装态行为由 E2E 验证。统一入口管理准备和运行顺序，聚焦调试可直接使用 [scripts/](../../integrations/dsh/scripts) 中对应脚本。

新补丁先用 `check-patched-host.mjs` 验证，再纳入 `series.json`。升级步骤见[上游升级参考](upstream-upgrades.md)。

## 可复用双 World 环境

宿主运行官方 DSH 和浏览器，Docker 提供两个具有相同 `/workspace` 路径的独立 Linux SSH 环境。

```sh
npx --no-install playwright install chromium
npm run test-e2e
```

Linux 可能需用 `--with-deps` 安装浏览器系统依赖。统一入口准备扩展、测试 profile、补丁宿主、附件及浏览器 fixture；单独运行 E2E 脚本前也需要这些准备。

各测试共享构建产物，使用独立容器状态；结束后清理测试资源。覆盖范围、环境变量和失败清理见 [E2E 说明](../../integrations/dsh/tests/e2e/README.md)。原生测试不代替 Linux/SSH 验收。

CI 保留 unchanged-source、patched-host、SSH 与浏览器回归，并以官方 CLI 验收安装包；具体步骤与结果以 workflow 为准。候选产物及发布见[发行](release.md)。

## 真实模型验收

可选的真实模型测试使用私有凭据配置，见 [E2E 说明](../../integrations/dsh/tests/e2e/README.md#optional-live-and-recording-lanes)。

```sh
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/scripts/web-e2e.mjs --live "$PRIVATE_DEEPSEEK_HOME"
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/extension-install.mjs "$PRIVATE_DEEPSEEK_HOME"
```

## 生成文件与清理

| 目录 | 内容 |
| --- | --- |
| `.local/` | 私有配置，可由根 justfile 导入 |
| `runtime/helper/target/` | Cargo 编译产物 |
| `.build/dsh/` | 依赖、构建、测试状态和私有日志 |
| `artifacts/dsh/` | 脱敏验收报告与截图 |
| `dist/dsh/` | 扩展和发行归档 |
| `.build/runtime/`、`dist/runtime/` | helper 发行暂存与归档 |

测试结束后，`just clean` 清理 `.build/`；`clean-reports`、`clean-dist`、`clean-rust` 分别清理报告、发行文件和 Cargo 产物。凭据与私有测试状态不上传。

当前契约在 `docs/`，计划和历史证据在 [.agents/notes/](../../.agents/notes/README.md)。历史验收记录不随代码重写。

## 离线产物与已有配置

安装和 World 配置见 [README](../../README.md) 与 [World 配置](../reference/worlds.md)。运行组件按扩展版本下载并校验，缓存可离线复用。

离线维护可指定 `bootstrap: {manifest, cacheDir}`，或使用 `dsh-remote-config init-release RELEASE_DIRECTORY WORLDS.json` 初始化匹配的完整发行包；已有状态不覆盖。移除显式 bootstrap 后恢复自动下载。

升级需成对验证 DSH 与扩展。卸载扩展保留配置与历史，已有 SSH Session 仍需扩展才能执行。
