# 双 SSH World E2E 环境

Status: implemented

## 决定

采用用户选定的宿主 DSH + Docker 双 World 拓扑；运行接口和清理契约见 `integrations/dsh/tests/e2e/README.md`。DSH-specific fixture、runner 和 workflow 归属此集成，不引入 runtime 对 DSH 的依赖。浏览器方法沿用上游 Vitest + Playwright Chromium + 真实 Web scaffold；受限 browser lane 的后续实现与证据见 [Web/SSH 验收](2026-09-07-web-ssh-acceptance.md)。

## 验收

2026-09-07，本地 macOS arm64 / OrbStack，Docker 29.4.0、Compose 5.1.2、Node 24.19.0。Linux helper 使用 Rust 1.85.1 和锁定 Cargo 依赖在 Debian bookworm arm64 容器中构建。上游 revision 及补丁序列仍由 `integrations/dsh/patches/series.json` 唯一定义；环境首次验收基线为 d347e703908d0406b7a7ef80e3a0e594d86b2215，当时只有 Session admission 补丁；当前序列及复测见新的 Web/SSH 记录。

- `npm run check`、patched-host 类型检查/构建、YAML 解析、shell/Node 语法和 diff whitespace 检查通过。
- 原生 admission 回归 21 项 PASS；helper Unix socket 需在允许本地 socket 的环境运行。
- `e2e.mjs -- node target/patched-host/admission.mjs`：20 项 PASS。真实生产 SSH bootstrap，两个独立 Linux 文件系统共享路径名 `/workspace`，不同标记验证隔离；包括直接 create/adopt、并发选择冲突、fork、跨宿主进程冷恢复、observed/Typert 入口、丢失或修改 binding 的拒绝。
- SSH lane 明确跳过原生 connector 注入的 unavailable 用例；此 controller fixture 不测试真实容器消失；后续 browser lane 另行覆盖停止 World，不把该跳过算作通过。
- 成功和故意让子命令退出 7 的失败场景，都确认容器、网络、`target/e2e/run-*` 临时配置/密钥已移除。故意失败正确使 runner 非零退出；未测试 SIGKILL/宿主崩溃清理。
- 本地原始日志在忽略提交的 `target/e2e-ssh.log`、`target/e2e-failure-cleanup.log` 和 `target/patched-host/native-acceptance.log`。

Ubuntu workflow 已配置同一入口，尚未观察 GitHub runner 执行结果；macOS arm64 结果不等同于 Linux 宿主 x86_64 验收。本 note 只记录最初的环境/controller 验收；后续浏览器和受控 Web Search 证据单独记录。worktree 仍未实现。

## 后果与替代方案

容器不挂载宿主项目目录，避免同一个宿主目录伪装成两个 World；每次生成 SSH 密钥和端口，不依赖个人 SSH 配置。Docker 镜像/构建缓存保留，运行态资源按本次 stack 清理。已有 SSH/Podman gate 保留，未修改 unchanged-source gates。控制器 gate 提供更快定位；不能替代经真实产品页面触发的浏览器验收。
