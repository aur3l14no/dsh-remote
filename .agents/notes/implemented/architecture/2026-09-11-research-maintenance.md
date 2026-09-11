# Research 维护成本收敛

Status: implemented

## 决定与范围

alpha 阶段、暂无用户，以当前实验的执行正确性和反馈速度为目标。用户授权落实全部七项建议，允许移除历史兼容，并行 Agent 分担身份、开发入口和补丁审计。固定 DSH `0.1.5-rc.1` / `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`，不同时重写 runtime 或引入新 provider。

1. **只支持当前状态。** BindingStore 仅接受 v3，删除 v1/v2 升级与备份分支、旧 registry/skill 回退和历史原生 Session adoption。当前 registry 使用 `portable_workspaces`。删除 ssh-world 中 bindings/worlds/routing/FS/process 转发层，通用执行适配归 execution-world。保留原子持久化、冲突拒绝、损坏和缺失时拒绝执行。
2. **明确执行身份。** `WorldDefinition` 是环境与 target，不含 cwd；`WorkspaceDefinition` 是独立 ID、worldId、canonical cwd 和 target 快照；Binding 是 Session → Workspace；Runtime 是当前资源 owner。构造、校验和指纹集中在 `identity.ts`。模型与审批分别显示 world/workspace/kind；helper 线协议不变。
3. **分离展示状态。** `presentation.ts` 保存 pins/archive 和投影；registry 保留身份、membership 与 lineage。置顶不再改 workspace 时间戳。独立 `followWorlds` stream 提供初始快照、合并失效通知和取消清理；浏览器只从 stream 写入展示快照，避免迟到的 unary 响应覆盖其他客户端的新状态。本机与 SSH 同样拒绝移除已绑定 Session membership。
4. **缩小补丁面。** 删除纯展示的 `0011-sidebar-primary-actions.patch` 和对应 bundle overlay，使用原生 New session，Reload worlds 留在扩展入口。series 从 11 减为 10；路径规范化与交付能力补丁仍有行为价值，不为减少数量引入绕行。固定 revision、checksum、unchanged-source 和独立 patched-host gate 保留。
5. **统一开发入口。** npm / just 提供 `check`、`test`、`test-integration`、`test-e2e`、`package`。薄编排负责前置条件和顺序，底层 gate 可单独运行。只保留根 npm lockfile；上游依赖准备仍按上游要求。Cargo manifest、lockfile、target 仍在 runtime/helper。
6. **减少重复准备。** patched-source 准备共用一个实现；完整 E2E 每次只构建一次扩展、profile、浏览器 fixtures 和 SSH 镜像/helper。每条 Linux lane 重建容器，避免共享可变文件污染；混合隔离破坏性用例最后运行。删除只用于旧 V2 迁移的 fixture，保留当前格式冷恢复、同名 cwd 隔离、child、取消、未知结果不重放和安装包验收。
7. **收敛事实与未来范围。** docs 保存当前契约，按时间的决定和证据留 notes；AGENTS 增加研究阶段维护规则。E2B、平台矩阵、自动 worktree、安装 GC 等仅保留问题边界，有具体实验需求再立项，不提前建设框架。

## 验收发现的实际缺陷

原生附件测试暴露 helper 对 executable 全路径 canonicalize 会把 Nix `rm` symlink 变成 `coreutils`，丢失 multicall 调用名称。现在仅解析父目录，保留最终文件名/symlink。协议形状与版本不变；新增真实 helper 回归覆盖 PATH、绝对 symlink、symlinked PATH 父目录和已解析路径再调用，附件删除仍使用 bare `rm` 并断言成功退出。此修复不改写 shell 字符串。

## 最终验证

- `npm run check`：通过 Rust fmt/clippy、自有 TS、固定未修改上游接口、patched-host、自有浏览器插件、preview 与附件类型 gate。
- `npm test`：45 项，43 passed、2 skipped、0 failed。两项环境依赖测试在快速测试中明确跳过，Linux/SSH 与安装态由独立 E2E 负责。
- `npm run test-integration`：通过 unchanged-source 装配、agents/terminal/session-routing/local-world/portable workspace、独立包消费者、patched admission 与附件行为 gate。
- `npm run test-e2e`：通过 11 项打包/客户端测试、本机浏览器测试和全部九条 Linux/SSH lane（准入、附件、技能部署、配置重载、Web、浏览器附件、扩展安装、连接时安装/离线缓存、本机与双 SSH 混合隔离）。最终安装包包含新的 helper 与执行上下文投影；双客户端展示同步和当前 v3 冷恢复通过。测试容器已清理。
- `git diff --check` 与当前文档相对链接检查通过；本机最终界面截图已人工检查。

[结构化验收结果](evidence/2026-09-11-research-maintenance.json) 保存本轮最终摘要；原始临时日志在私有构建目录，未复制到公共证据。安装包由 E2E 中唯一 build-extension 链重新构建，产物位于 dist/dsh。

## 使用边界

升级使用新的私有 DSH_HOME 和 binding 存储重新声明 World、创建会话；不把旧 registry/binding 复制进去，不自动迁移历史会话，也不删除用户项目或私有配置。当前冷恢复能力针对当前 v3 状态。完整说明见[绑定契约](../../../../docs/reference/session-bindings.md)。

原生 macOS fixture、真实 Linux/SSH、浏览器和安装包证据各自独立，不推断其他原生平台、真实外部连接器失败矩阵或未来 provider 已通过。未公开发布、未提交 Git。统一入口和前置条件见[开发文档](../../../../docs/development.md)。
