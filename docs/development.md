# 开发与验证

所有命令从仓库根执行。Rust 1.85+、Node.js 24+；使用已有工具链与 lockfiles，不通过验证命令安装系统工具。项目依赖通过 `npm ci` 安装。

根目录保留 workspace 配置、lockfiles、README/LICENSE/AGENTS 和 justfile。代码、测试与脚本按所属子系统收录：通用测试在 `runtime/tests/`，产物准备/上传脚本在 `runtime/scripts/`，DSH 专用入口在 `integrations/dsh/`。

私有配置放入忽略提交的 `.local/`；根 justfile 可选导入 `.local/justfile`。`target/`、`runtime/helper/target/` 与 `node_modules/` 是忽略提交的构建产物和依赖目录。

## 选择验证入口

DSH 脚本集中在 `integrations/dsh/scripts/`；通用 runtime 检查留在自己的子系统。按修改范围选择检查，不必每次运行全部入口。

| 修改范围 | 主要入口 | 证明范围 |
| --- | --- | --- |
| 通用 runtime | 下节 Cargo、npm 检查；协议变更再跑 Linux/SSH | helper、client 和 bootstrap 契约 |
| 外部插件或装配 | `check-web-plugin`，构建扩展后跑安装/双 World 浏览器验收 | 我们的源代码及用户实际安装链路 |
| 上游版本或补丁 | unchanged-source composition/package gates + 独立 `check-patched-host`；再跑完整扩展验收 | 区分原生上游边界、补丁行为和安装态兼容 |
| 浏览器兼容包 | `check-preview-client` + 构建扩展、浏览器验收 | 独立浏览器类型环境与实际 UI |
| 纯文档 | 相对链接、路径、当前事实与历史记录一致性 | 不以无关运行测试替代文档审查 |

产品装配入口为 `integrations/dsh/packages/bundle/remote/src/index.ts`；浏览器入口仍在 `packages/workspace/portable-workspace/src/client/index.tsx`。两者由 `build-extension.mjs` 收录，服务顺序和产物身份属于维护契约。

## 通用代码

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo build --locked
npm run check
npm test
```

根 Cargo.toml 是 workspace，runtime/helper/Cargo.toml 定义二进制包；Cargo.lock 保留在根目录；`.cargo/config.toml` 将 Cargo 产物统一输出到 `runtime/helper/target/`，从根目录或 helper 目录执行均适用。默认测试包含 client、bootstrap 的不需远端场景、DSH bindings 和 skill 查询取消；显式 SSH/native-bootstrap 用例会按环境配置启用。

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
DSH_TEST_RG="$LOCAL_RG" node target/composition/session-routing.mjs
node integrations/dsh/scripts/build-composition.mjs "$DSH_SOURCE" portable_workspace
DSH_TEST_RG="$LOCAL_RG" node target/composition/portable_workspace.mjs
node integrations/dsh/scripts/pack-plugin.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/check-plugin.mjs "$DSH_SOURCE"
DSH_TEST_RG="$LOCAL_RG" DSH_TEST_PACKAGED=1 node target/package-check/accept.mjs
```

`portable_workspace` 测试明确复现现有 Web 缺口；通过不表示完整 Web 可用。打包产物位于 target/packages/，公开的插件入口名称不因源码迁移改变。声明文件内的目录结构属于打包实现，不是消费者 API。

Session 准入和路径补丁有独立源码 gate：从干净基线导出隔离副本，校验补丁摘要并顺序应用，检查改动宿主包与集成的类型、构建行为 fixture。安装态宿主另外走下面的扩展构建和浏览器入口。

```sh
node integrations/dsh/scripts/check-patched-host.mjs "$DSH_SOURCE"
DSH_TEST_RG="$LOCAL_RG" node target/patched-host/admission.mjs
```

输出在 target/patched-host/；build.json 记录基线和补丁摘要。开发新补丁可在命令末尾指定 patches/ 内的候选文件名，验证后再纳入 series.json。保留原来的 unchanged-source gate，避免把修改后的宿主误记为原生兼容。所有测试与构建产物都在各自 target 子目录中，不能在 target 根声明一个上游 npm 包。

SSH/Podman 验收用 `integrations/dsh/scripts/accept-podman.mjs` 和 `accept-portable_workspace.mjs`，参数通过显式环境输入；只允许针对已选目标操作测试资源。宿主名、SSH 配置、token 不写入公共文档和报告。helper 与 ripgrep 必须使用目标平台产物。

## 可复用双 World 环境

本地 Mac/OrbStack 与 GitHub Ubuntu runner 使用同一 Docker Compose 拓扑：宿主运行 DSH 和测试，两个 Linux 容器各自提供 SSH、helper 和独立 Git 仓库，路径均为 `/workspace`。运行命令通过真实 SSH bootstrap 访问 World；临时密钥、端口和测试资源由 runner 管理。

```sh
node integrations/dsh/scripts/check-patched-host.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/e2e.mjs -- node target/patched-host/admission.mjs
```

浏览器层复用上游 Vitest + Playwright fixture，但实际 CLI、服务和前端来自官方 npm 安装；不构建整套 DSH。开发者、CI 和用户安装同一扩展 tarball：

```sh
node integrations/dsh/scripts/prepare-official.mjs
node integrations/dsh/scripts/build-extension.mjs "$DSH_SOURCE" target/official-install
node integrations/dsh/scripts/prepare-test-profile.mjs
node --test integrations/dsh/tests/packaging/*.test.mjs
node integrations/dsh/scripts/check-web-plugin.mjs
node integrations/dsh/scripts/check-preview-client.mjs
node integrations/dsh/scripts/prepare-browser-fixtures.mjs
npx --no-install playwright install chromium
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/skills-deployment.mjs
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/scripts/web-e2e.mjs
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/extension-install.mjs
```

Linux CI 使用 Playwright 的 `--with-deps` 安装浏览器系统依赖。`prepare-official` 从维护中的 lockfile 安装官方包及测试声明依赖；新版官方文件锁不再需要本地重编译 fs-ext。`build-extension` 导出固定源码，编译补丁涉及的 9 个兼容包（含 ui-chat 浏览器模块）和外部插件。fixture 准备只复制测试、录制与 mock，不作为产品宿主。`DSH_TEST_INSTALL` 可指定另一安装目录。

CI 保留 unchanged-source、patched-host、SSH 与完整浏览器回归，并以官方 CLI 验收安装包；通过后上传扩展 tarball。截图与脱敏结果保留 7 天，扩展候选产物保留 14 天。临时状态、凭据和缓存不上传。GitHub runner 的实际结果以 CI 为准。

当前 browser/SSH 验收覆盖创建与同路径隔离、rename/order/archive/remove/恢复登记、原生 fork、冷启动 deep link、新 runtime、远端 AGENTS/skills 与部署脚本、文件补全、后台 jobs 及取消、丢失 binding、停止 World 和宿主 Web Search 边界。另有真实 DeepSeek/外部搜索验收及原生 CLI 安装检查；不代表默认工具全集或公开 npm 包验收。环境接口、清理与测试脚手架适配见 [E2E 说明](../integrations/dsh/tests/e2e/README.md)。

## 文档与证据

`Helper prebuild` workflow 在相关 PR、main 修改或手动触发时构建 Linux x86_64 musl helper，使用固定 Rust 1.85.1，检查无动态解释器并运行目标测试。通过后上传含二进制、LICENSE、源码 revision 和 SHA256SUMS 的 tar.gz，保留执行权限。这是 CI 候选产物，不是完整 bootstrap bundle：尚未包含 ripgrep、可信下载清单或公开发布入口；GitHub runner 的实际结果需在推送后确认。

`docs/` 保持当前概念、接口和使用方式简洁。未完成工作、试验结果和取舍放入 [.agents/notes](../.agents/notes/README.md)。原始验收 JSON 保留原字节和历史状态，路径迁移不等于重新验收。新的结果先写 target/，需要长期保留时以新时间记录入 notes，不能覆盖旧证据。

移动代码时验证相对 import、TS include、Cargo workspace、esbuild 源码边界、npm exports/declarations 和脚本路径。结构重整不顺便改变协议、会话绑定格式或执行权限。

Skills 配置与部署入口见 [Skills 与项目指令](skills.md)。当前假设与 workaround 集中在[验收一页纸](../.agents/notes/implemented/architecture/2026-09-08-assumptions-and-workarounds.md)。

真实模型验收（手动、需要仅含 DeepSeek key 的私有配置）与原生安装检查：

```sh
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/scripts/web-e2e.mjs --live .local/deepseek-only
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/tests/e2e/extension-install.mjs .local/deepseek-only
```

第一条读取私有配置的 `.credentials.yaml` 中 `refs.DEEPSEEK_API_KEY`，只注入宿主；发送的是新建双 World 的合成任务数据。安装 gate 通过扩展启动官方 DSH CLI，经 Playwright 创建远端 Session；提供凭据目录时还执行真实模型的远端写入/测试与另一 World 隔离检查，不使用 scaffold。安装与配置见[安装](install.md)。

新版预览验收覆盖同路径宿主/双 World 隔离、范围读取、图片与原生 Sidebar、symlink 拒绝和跨 World 变更通知。迁移用例在一次性状态内植入 V2 压缩日志，检查 V3 恢复、原日志保留与 bindings 不变。浏览器补丁用独立类型程序验证，避免宿主与浏览器的 Cordis Context 声明互相污染。
