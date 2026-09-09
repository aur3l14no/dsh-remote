# DSH 0.1.5-alpha.1 适配验收

Status: implemented

## 决定与范围

官方 revision `5dda764ed3aa172535a7967b06ff95d9cbfe536a`，扩展 0.3.0，helper 0.1.3。交付继续使用官方 npm + 原生 plugin add；原有 5 个补丁可应用，新增 0006 将文件预览绑定显式 Session/World，共覆盖 9 个包。

真实替代方案是只升级旧能力并关闭新预览。这里选择增加 workspace-files environment seam 和 ui-chat 的 Session URL / 远端 stat：复用原生 Sidebar，不引入宿主 FS、URL 路径猜测或整文件下载模拟范围。只单独构建 ui-chat 浏览器模块，官方 Web frontend 保持预构建产物。

## 本地证据（2026-09-09）

- Rust fmt、Clippy、构建及 TypeScript 检查通过；npm test 33 通过、2 个需显式环境的用例跳过。
- 原生 composition、SSH plugin 导出/声明、patched-host 源码门禁、独立 Chat 客户端类型门禁通过。
- patched-host 真实双 Linux/SSH 准入、默认本地行为和跨宿主持久化通过。
- 官方 CLI plugin add/repeat/remove/version guard 通过；0.3.0 原生安装和自动/手动 Skills 同步通过，不用 scaffold。
- 双 World Playwright 通过：同路径隔离、文件操作、Web Search 边界、fork、子 Agent、冷恢复、取消、缺失 binding 与不可用 World。
- 新预览覆盖：宿主及两远端同绝对路径；缺失/无效 Session 拒绝；GET/HEAD；范围读取；图片实际加载；原生 Produced 文件点击；`..` 远端解析；越根/symlink 拒绝；跨 World 变更通知过滤。
- 合成 V2 zstd 会话经官方 controller 恢复到 V3，旧日志字节保留，system/user history 保留，bindings 不变，并继续后续冷恢复/断线回归。
- Skills 专项部署、幂等、更新、冲突拒绝及脚本执行通过。
- 真实 DeepSeek v4 flash + 外部搜索通过：searchSucceeded、codingTestsPassed、remoteCredentialAbsent、otherWorldUnchanged 均为 true。结果时间 2026-09-09T02:40:47Z。

原始本地输出位于忽略的 target/upgrade-audit/ 与 target/web-acceptance/；不提交私有状态。GitHub runner 和 prebuild 结果以相应 revision 的 Actions 为准，本记录不以本地结果代替 CI。

## 维护与边界

改动按协议、版本、预览、路径修复、类型门禁、发行、fixture 依赖和迁移测试分别提交。安装文档要求官方 DSH/扩展成对升级，并备份 DSH home 与外部状态；旧版不能读取 V3，不自动迁移用户真实会话。目录树/文本预览限制在 workspace，图片保留账户可读绝对路径；OS sandbox、附件传输和 worktree 编排不属于本轮适配。
