# 开发与验证

除明确切换到 helper 的 Cargo 命令外，入口命令从仓库根执行。Rust 1.85+、Node.js 24+；使用已有工具链与 lockfiles，不通过验证命令安装系统工具。项目依赖通过 `npm ci` 安装。

私有配置放入忽略提交的 `.local/`；根 justfile 可选导入 `.local/justfile`。生成目录按生命周期划分，均忽略提交：

| 目录 | 内容与清理边界 |
| --- | --- |
| `runtime/helper/target/` | Cargo 自己管理的编译产物；用 Cargo clean 清理 |
| `.build/dsh/` | 官方依赖安装、兼容源码副本、编译 staging、测试 fixture 和私有临时状态；可重建，测试运行中勿清理 |
| `artifacts/dsh/` | 脱敏验收 JSON、截图；按需保留，CI 仅上传显式清单 |
| `dist/dsh/` | 用户扩展 tarball 与完整发行归档；不存临时配置或测试 fixture |
| `.build/runtime/`、`dist/runtime/` | 通用 helper 发行暂存与最终归档；不放入 Cargo target |

`node_modules/` 由包管理器管理；私有诊断日志只写 `.build/dsh/logs/`，不混入可上传报告。根目录不再使用 `target/`，也不设置旧路径兼容软链接。

清理命令按上述边界执行：`just clean` 只删除 `.build/`；`just clean-reports` 删除报告；`just clean-dist` 删除发行文件；`just clean-rust` 调用 helper 的 Cargo clean。测试进程结束后再清理。历史 notes 的路径保留原文，不作为当前脚本输入。

## 选择验证入口

DSH 脚本集中在 `integrations/dsh/scripts/`；通用 runtime 检查留在自己的子系统。按修改范围选择检查，不必每次运行全部入口。

| 修改范围 | 主要入口 | 证明范围 |
| --- | --- | --- |
| 通用 runtime | 下节 Cargo、npm 检查；协议变更再跑 Linux/SSH | helper、client 和 bootstrap 契约 |
| 外部插件或装配 | `check-web-plugin`，构建扩展后跑安装/双 World 浏览器验收 | 我们的源代码及用户实际安装链路 |
| 上游版本或补丁 | unchanged-source composition/package gates + 独立 `check-patched-host`；再跑完整扩展验收 | 区分原生上游边界、补丁行为和安装态兼容 |
| 浏览器兼容包 | `check-preview-client` + 构建扩展、浏览器验收 | 独立浏览器类型环境与实际 UI |
| 发行组装 / 初始化 | `node --test integrations/dsh/tests/release/*.test.mjs`；构建扩展后跑 packaging 与 extension-install | 摘要、拒绝损坏、私有 cache 与官方 CLI / SSH 安装 |
| 纯文档 | 相对链接、路径、当前事实与历史记录一致性 | 不以无关运行测试替代文档审查 |

## 通用代码

```sh
(cd runtime/helper && cargo fmt --all --check)
(cd runtime/helper && cargo clippy --locked --all-targets -- -D warnings)
(cd runtime/helper && cargo build --locked)
npm run check
npm test
```

默认测试包含 client、bootstrap 的不需远端场景、DSH bindings 和 skill 查询取消；显式 SSH/native-bootstrap 用例会按环境配置启用。

```sh
python3 runtime/helper/tests/acceptance.py --help
python3 runtime/helper/tests/acceptance.py --platform macos \
  --helper runtime/helper/target/debug/dsh-remote --fixture runtime/helper/target/debug/dsh-remote-fixture --rg "$LOCAL_RG"
```

原生 macOS 只证明原生 fixture 行为。Linux build/acceptance 在对应 Linux 目标运行，必要时使用已有私有远端配置；不能把本机编译当成目标平台证明。

```sh
sh runtime/helper/scripts/build-linux.sh aarch64-unknown-linux-musl
node runtime/scripts/prepare-artifacts.ts --os linux --arch aarch64 --abi musl-static \
  --helper "$HELPER" --helper-version 0.1.3 --ripgrep "$RG" --ripgrep-version 15.2.0 \
  --cache "$CACHE" --out "$MANIFEST"
```

## 上游兼容检查（升级或补丁变更）

[patches/series.json](../integrations/dsh/patches/series.json) 是上游 revision 和补丁序列的唯一配置源。unchanged-source 脚本要求同一 revision 且 checkout 干净，始终只验证原生 composition；下游补丁走独立入口。

```sh
node integrations/dsh/scripts/check-composition.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/build-composition.mjs "$DSH_SOURCE" session-routing
DSH_TEST_RG="$LOCAL_RG" node .build/dsh/composition/session-routing.mjs
node integrations/dsh/scripts/build-composition.mjs "$DSH_SOURCE" portable_workspace
DSH_TEST_RG="$LOCAL_RG" node .build/dsh/composition/portable_workspace.mjs
node integrations/dsh/scripts/pack-plugin.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/check-plugin.mjs "$DSH_SOURCE"
DSH_TEST_RG="$LOCAL_RG" DSH_TEST_PACKAGED=1 node .build/dsh/package-check/accept.mjs
```

`portable_workspace` 测试明确复现现有 Web 缺口；通过不表示完整 Web 可用。低层 unchanged-source fixture 包位于 `.build/dsh/fixture-packages/`；用户发行文件位于 `dist/dsh/`，公开的插件入口名称不因源码迁移改变。声明文件内的目录结构属于打包实现，不是消费者 API。

Session 准入和路径补丁有独立源码 gate：从干净基线导出隔离副本，校验补丁摘要并顺序应用，检查改动宿主包与集成的类型、构建行为 fixture。安装态宿主另外走下面的扩展构建和浏览器入口。

```sh
node integrations/dsh/scripts/check-patched-host.mjs "$DSH_SOURCE"
DSH_TEST_RG="$LOCAL_RG" node .build/dsh/patched-host/admission.mjs
node integrations/dsh/scripts/build-composition.mjs "$DSH_SOURCE" local-world
node .build/dsh/composition/local-world.mjs
node integrations/dsh/scripts/check-attachments.mjs
DSH_TEST_RG="$LOCAL_RG" node --expose-internals .build/dsh/attachment-check/lib/attachments.mjs
```

输出在 .build/dsh/patched-host/；build.json 记录基线和补丁摘要。开发新补丁可在命令末尾指定 patches/ 内的候选文件名，验证后再纳入 series.json。保留原来的 unchanged-source gate，避免把修改后的宿主误记为原生兼容。只有具体 fixture 目录可以声明上游 npm 包身份，不能在 `.build/` 或 `.build/dsh/` 根声明，以免影响相邻构建的模块解析。

SSH/Podman 验收用 `integrations/dsh/scripts/accept-podman.mjs` 和 `accept-portable_workspace.mjs`，参数通过显式环境输入；只允许针对已选目标操作测试资源。宿主名、SSH 配置、token 不写入公共文档和报告。helper 与 ripgrep 必须使用目标平台产物。

## 可复用双 World 环境

本地 Mac/OrbStack 与 GitHub Ubuntu runner 使用同一 Docker Compose 拓扑：宿主运行 DSH 和测试，两个 Linux 容器各自提供 SSH、helper 和独立 Git 仓库，路径均为 `/workspace`。运行命令通过真实 SSH bootstrap 访问 World；临时密钥、端口和测试资源由 runner 管理。

```sh
node integrations/dsh/scripts/check-patched-host.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/e2e.mjs -- node .build/dsh/patched-host/admission.mjs
```

浏览器层复用上游 Vitest + Playwright fixture，但实际 CLI、服务和前端来自官方 npm 安装；不构建整套 DSH。开发者、CI 和用户安装同一扩展 tarball：

```sh
node integrations/dsh/scripts/prepare-official.mjs
node integrations/dsh/scripts/build-extension.mjs "$DSH_SOURCE" .build/dsh/official-install
node integrations/dsh/scripts/prepare-test-profile.mjs
node --test integrations/dsh/tests/packaging/*.test.mjs
node --test integrations/dsh/tests/client/*.test.mjs
node integrations/dsh/scripts/check-web-plugin.mjs
node integrations/dsh/scripts/check-preview-client.mjs
node integrations/dsh/scripts/prepare-browser-fixtures.mjs
npx --no-install playwright install chromium
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/skills-deployment.mjs
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/worlds-reload.mjs
node integrations/dsh/scripts/local-e2e.mjs
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/scripts/local-e2e.mjs
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/scripts/web-e2e.mjs
node integrations/dsh/scripts/e2e.mjs -- node --expose-internals .build/dsh/attachment-check/lib/attachments.mjs
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/scripts/web-e2e.mjs --attachments
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/extension-install.mjs
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/connect-install.mjs
```

`local-world` 验证显式 local 分派不会调用 bootstrap、SSH connector 或远端 skill preparation；不以替身证明原生 IO。`local-e2e` 在原版官方宿主创建本机历史，再在同一状态装扩展，检查本机迁移、权限、文件／进程、skills、子会话、附件及浏览器。通过双 World runner 运行时增加同路径混合隔离、Reload 和 SSH 容器停止后本机继续运行。只有在 macOS 上运行的本机 gate 才证明 macOS 接入。

Linux CI 使用 Playwright 的 `--with-deps` 安装浏览器系统依赖。`prepare-official` 从维护中的 lockfile 安装官方包及测试声明依赖。`build-extension` 导出固定源码，编译补丁涉及的兼容包（含 ui-chat 和 Sidebar 浏览器模块）和外部插件。fixture 准备只复制测试、录制与 mock，不作为产品宿主。`DSH_TEST_INSTALL` 可指定另一安装目录。

CI 保留 unchanged-source、patched-host、SSH 与完整浏览器回归，并以官方 CLI 验收安装包；通过后上传扩展 tarball，以及包含已验收 Linux helper/ripgrep 的完整候选归档。手动触发 GitHub Actions 发布的流程见[发行](release.md)。截图与脱敏结果保留 7 天，扩展候选产物保留 14 天。临时状态、凭据和缓存不上传。GitHub runner 的实际结果以 CI 为准。

各 gate 的覆盖范围、环境变量、清理和测试脚手架适配统一见 [E2E 说明](../integrations/dsh/tests/e2e/README.md)。

## 文档与证据

`Helper prebuild` workflow 在相关 PR、main 修改或手动触发时构建 Linux x86_64 musl helper，使用固定 Rust 1.85.1，检查无动态解释器并运行目标测试。通过后上传含二进制、LICENSE和源码 revision 的 tar.gz，保留执行权限。这是 CI 候选产物，不是完整 bootstrap bundle：尚未包含 ripgrep、可信下载清单或公开发布入口；GitHub runner 的实际结果需在推送后确认。

`docs/` 保持当前概念、接口和使用方式简洁。未完成工作、试验结果和取舍放入 [.agents/notes](../.agents/notes/README.md)。原始验收 JSON 保留原字节和历史状态，路径迁移不等于重新验收。新的脱敏结果先写 `artifacts/dsh/`，需要长期保留时以新时间记录入 notes，不能覆盖旧证据。

移动代码时验证相对 import、TS include、Cargo crate 路径、esbuild 源码边界、npm exports/declarations 和脚本路径。结构重整不顺便改变协议、会话绑定格式或执行权限。

## 真实模型验收

手动运行，需要仅含 DeepSeek key 的私有配置；凭据读取与数据范围见 [E2E 说明](../integrations/dsh/tests/e2e/README.md#optional-live-and-recording-lanes)。

```sh
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/scripts/web-e2e.mjs --live .local/deepseek-only
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/extension-install.mjs .local/deepseek-only
```

## 离线产物与已有配置

正常使用只需 README 中的插件安装命令，首次启动自动创建私有配置、`worlds.json` 和绑定存储；按 [World 配置](worlds.md) 声明目录，在 Web 的 **Reload worlds** 中预览并确认，再到新会话选择器中选择。缺失已有绑定文件时仍拒绝重建。连接使用非交互模式，认证方式、主机密钥检查和 SSH 连接超时遵循用户的 OpenSSH 配置；需要交互的密码、私钥口令和主机信任在终端 OpenSSH 中处理。

SSH 连接使用配置中明确的 `target.host`。目录在选择工作区时通过现有 World provider 校验；SSH 不提供主机发现、连接管理或目录浏览 API。本机人机目录选择复用原生 picker，显式访问 DSH 宿主；不向模型授予未绑定的宿主文件／进程能力。

运行时随扩展版本从对应 GitHub Release 下载到 `$DSH_HOME/remote/releases/<version>/`，校验后才通过 SSH 部署。缓存可离线复用；新扩展使用新版本目录，不替换活跃 runtime。远端不需要公网或编译器。平台选择仍由远端探测决定。

离线部署和开发 fixture 可以保留显式 `bootstrap: {manifest, cacheDir}`。`dsh-remote-config init WORLD_CONFIG.json` 初始化显式配置；`init-release RELEASE_DIRECTORY WORLDS.json` 从匹配的完整包初始化。它们是维护入口，不是用户安装步骤，不覆盖已有状态。此模式的 runtime 由维护者更新，自动下载只用于未设置 bootstrap 的配置。

升级前停止 DSH 并备份 DSH_HOME 与外部 binding/Session 存储，按上游兼容矩阵成对更新 DSH 和扩展。已有配置不重新 init；要从手动 runtime 管理迁移为自动下载，仅删除配置中的 bootstrap，保留 worlds.json、bindingFile 和绑定存储。V3 会话不能直接交给旧 DSH，回退需恢复备份。

卸载使用 `dsh plugin --profile web remove @dsh-remote/extension`，保留远端配置与历史；已有远端 Session 仍需扩展才能执行。多个 profile 共享同一 DSH_HOME 时也共享远端配置。
