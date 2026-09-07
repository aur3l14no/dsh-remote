# Web / SSH 验收：受限 remote profile

Status: implemented

## 决定与范围

采用宿主 DSH + 浏览器、两个 Linux SSH World 的拓扑。维护 4 个原生包的补丁（Session 准入、workspace feed、Bash workdir、FS cwd），将 portable_workspace catalog、路由和 Web 选择界面放在下游 plugin。固定 revision 和补丁摘要以 `integrations/dsh/patches/series.json` 为准。

当前实现面向受限 remote preset：原生前台 Bash、read/write/edit、grep/glob 与宿主 Web Search。关闭未适配的默认 preset、目录选择、本地 sandbox、Session 引用和本地路径 opener。没有通过全局 FS 替换或本地执行回退扩充能力。

替代方案是继续只验证 controller composition，或直接启用默认工具全集。前者不足以证明 Web 激活和冷启动，后者会暴露尚未适配的本地消费者，因此本次采用实际 Web 闭环与显式受限能力集。

## 验收记录

2026-09-07，Mac arm64 / OrbStack，Node 24.19.0、上游固定 pnpm 11.7.0；helper 在 Rust 1.85.1 Debian builder 中构建。原始运行产物保留在忽略提交的 target/，不保存临时 SSH 密钥、binding 或 host state。

- 从干净固定上游导出、校验并应用全部补丁、冻结依赖安装、完整 Web 构建成功，生成 222 个 client artifacts。
- patched-host 源码/类型 gate 通过；native admission 21 个 PASS，真实双 World SSH admission 20 个 PASS。
- 原生 FS/Bash 回归：3 个文件、162 tests 通过；native opener 回归 7 tests 通过。
- unchanged-source portable_workspace 与 Session routing gate 通过；既有 SSH 插件打包、消费者类型与安装产物行为验收通过。
- 下游 Web plugin 类型检查与根 TypeScript 检查通过；根测试 25 passed、2 skipped，跳过不记为成功。
- 浏览器验收在 `2026-09-07T09:07:57.805Z` 完成：1 个综合生命周期场景通过。入口为 `e2e.mjs -- node integrations/dsh/scripts/web-e2e.mjs`，沿用上游 Vitest + Playwright Chromium scaffold。

浏览器场景实际覆盖：

1. 通过 UI 明确选择 World A/B，登记各自 `/workspace` 并创建 Session；同路径身份和远端文件隔离。
2. 原生 read、Bash、write、read-before-edit、edit、grep、glob、Web Search；第二轮使用独立 tool-call ID 和新文件，避免 replay 与历史轨迹冲突。
3. 原生 UI fork 继承 binding；冷 host 重启后通过 deep link 恢复 Session，在新 runtime 中再次完成工具轮次。
4. Stop generating 终止远端进程，验证 PID 已退出且未产生完成标记。
5. 删除保存 binding 后拒绝启动；停止 World B 后拒绝连接；不发布 Agent、不重建错误 binding、不回退宿主。
6. 原生搜索 provider 使用受控宿主 HTTP 端点；验证测试凭据没有进入远端 env，远端 Shell 无法连接宿主 loopback 搜索端点。

模型输出使用 synthetic replay，文件、进程、SSH、Web transport 和原生搜索 provider 都实际运行。容器、网络与临时状态在完成后清理。

## 维护约束与后续

- `scaffold.patch` 仅适配测试持久状态和目录选择，不属于产品补丁。Vitest alias 保证下游与 scaffold 共享原生 scope 身份。
- 导出的 checkout 限制 Git 向上查找；非 Git 构建显式传上游 commit，防止补丁被跳过或构建脚本误用外层仓库。
- 测试用上游 package metadata 收录在各自 target 子目录，不依赖 target 根残留文件。registry 从 experiment 提升为维护实现，旧入口仅 re-export。
- GitHub Ubuntu workflow 已配置，尚未在 GitHub 执行；源码构建不代表公开 npm 安装包验收。
- 尚未验收真实模型/外部搜索服务、搜索连接器故障与取消、双 Session 并发搜索。受控端点只证明执行边界。
- instructions/skills 非工具消费者、后台任务、终端、子 Agent preset、附件传输和远端 worktree 编排仍未提供完整 Web 支持；管理 API 不代表完整管理 UI。

后续任务继续维护 proposed/integration/2026-09-07-world-portable_workspace-web.md，docs/ 只描述当前契约。
