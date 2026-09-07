# 开发与验证

所有命令从仓库根执行。Rust 1.85+、Node.js 24+；使用已有工具链与 lockfiles，不通过验证命令安装系统工具。项目依赖通过 `npm ci` 安装。

根目录保留 workspace 配置、lockfiles、README/LICENSE/AGENTS 和 justfile。代码、测试与脚本按所属子系统收录：通用测试在 `runtime/tests/`，产物准备/上传脚本在 `runtime/scripts/`，DSH 专用入口在 `integrations/dsh/`。

私有配置放入忽略提交的 `.local/`；根 justfile 可选导入 `.local/justfile`。`target/` 与 `node_modules/` 是忽略提交的构建产物和依赖目录。

## 通用代码

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo build --locked
npm run check
npm test
```

根 Cargo.toml 是 workspace，runtime/helper/Cargo.toml 定义二进制包；Cargo.lock 和 target/ 保留在根目录。默认测试包含 client、bootstrap 的不需远端场景和 DSH bindings；显式 SSH/native-bootstrap 用例会按环境配置启用。

```sh
python3 runtime/helper/tests/acceptance.py --help
python3 runtime/helper/tests/acceptance.py --platform macos \
  --helper target/debug/dsh-remote --fixture target/debug/dsh-remote-fixture --rg "$LOCAL_RG"
```

原生 macOS 只证明原生 fixture 行为。Linux build/acceptance 在对应 Linux 目标运行，必要时使用已有私有远端配置；不能把本机编译当成目标平台证明。

```sh
sh runtime/helper/scripts/build-linux.sh aarch64-unknown-linux-musl
node runtime/scripts/prepare-artifacts.ts --os linux --arch aarch64 --abi musl-static \
  --helper "$HELPER" --helper-version 0.1.1 --ripgrep "$RG" --ripgrep-version 15.2.0 \
  --cache "$CACHE" --out "$MANIFEST"
```

## DSH 兼容与发行

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

Session 准入和路径补丁有独立源码 gate：从干净基线导出隔离副本，校验补丁摘要并顺序应用，检查改动宿主包与集成的类型、构建行为 fixture。完整 Web 宿主另外走下面的构建和浏览器入口。

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

浏览器层沿用上游 Vitest + Playwright Chromium、真实 Web scaffold 和无密钥模型 replay。以下命令生成干净隔离 checkout，验证补丁摘要、安装固定依赖、完整构建 Web 并运行同一双 World 环境：

```sh
node integrations/dsh/scripts/prepare-web-host.mjs "$DSH_SOURCE"
node integrations/dsh/scripts/check-web-plugin.mjs
node integrations/dsh/scripts/e2e.mjs -- node integrations/dsh/scripts/web-e2e.mjs
```

需要 pnpm 与宿主 Chromium 系统依赖；首次构建会下载依赖和浏览器。`prepare-web-host` 只替换 `target/web-host`，不修改上游源码 checkout。Ubuntu workflow 使用同一入口，并显式安装浏览器系统依赖。该 workflow 已配置，本地通过不等于 GitHub runner 已执行。

当前 browser/SSH 验收覆盖创建与同路径隔离、原生 fork、冷启动 deep link、新 runtime、远端进程取消、丢失 binding、停止 World 和宿主 Web Search 边界。它不代表默认工具全集、公开安装包、真实模型或外部搜索服务验收。环境接口、清理与测试脚手架适配见 [E2E 说明](../integrations/dsh/tests/e2e/README.md)。

## 文档与证据

`docs/` 保持当前概念、接口和使用方式简洁。未完成工作、试验结果和取舍放入 [.agents/notes](../.agents/notes/README.md)。原始验收 JSON 保留原字节和历史状态，路径迁移不等于重新验收。新的结果先写 target/，需要长期保留时以新时间记录入 notes，不能覆盖旧证据。

移动代码时验证相对 import、TS include、Cargo workspace、esbuild 源码边界、npm exports/declarations 和脚本路径。结构重整不顺便改变协议、会话绑定格式或执行权限。
