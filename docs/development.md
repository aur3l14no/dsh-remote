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

首个 Session 准入补丁有独立源码 gate：从干净基线导出隔离副本，校验补丁摘要并顺序应用，检查改动宿主包与集成的类型、构建行为 fixture。完整 Remote 图发行及 profile/browser 仍待后续验证。

```sh
node integrations/dsh/scripts/check-patched-host.mjs "$DSH_SOURCE"
DSH_TEST_RG="$LOCAL_RG" node target/patched-host/admission.mjs
```

输出在 target/patched-host/；build.json 记录基线和补丁摘要。开发新补丁可在命令末尾指定 patches/ 内的候选文件名，验证后再纳入 series.json。保留原来的 unchanged-source gate，避免把修改后的宿主误记为原生兼容。完整 profile 验证前，不发布虚假的运行配置。

SSH/Podman 验收用 `integrations/dsh/scripts/accept-podman.mjs` 和 `accept-portable_workspace.mjs`，参数通过显式环境输入；只允许针对已选目标操作测试资源。宿主名、SSH 配置、token 不写入公共文档和报告。helper 与 ripgrep 必须使用目标平台产物。

## 文档与证据

`docs/` 保持当前概念、接口和使用方式简洁。未完成工作、试验结果和取舍放入 [.agents/notes](../.agents/notes/README.md)。原始验收 JSON 保留原字节和历史状态，路径迁移不等于重新验收。新的结果先写 target/，需要长期保留时以新时间记录入 notes，不能覆盖旧证据。

移动代码时验证相对 import、TS include、Cargo workspace、esbuild 源码边界、npm exports/declarations 和脚本路径。结构重整不顺便改变协议、会话绑定格式或执行权限。
