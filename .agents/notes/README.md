# Agent Notes

Notes 保存待办、重要决策和按时间记录的验收；当前使用方式与契约以 [docs/](../../docs/system-map.md) 为准。

```text
proposed/integration/        已选方向或待决方案，仍未完成实现
implemented/architecture/   已采用的结构/设计决策
implemented/integration/    已完成阶段的实现与验收记录
rejected/                   被否决且仍有防止重复试错价值的方案（按需创建）
archived/                   被替代的历史记录与原始验收证据
```

文件名为 `yyyy-mm-dd-topic.md`，声明 Status、决定或问题、适用基线与证据范围。只维护一份当前计划；proposed 表示工作未完成，不表示方向未经同意。

- [Agent Teams 与 rc.2](implemented/integration/2026-09-12-agent-teams.md) 记录宿主团队协调、跨 World 队友、冷恢复及窄屏面板验收。
- [单次跨 World 工具执行](implemented/integration/2026-09-12-tool-execution-environment.md) 记录调用环境、资源来源、审批上下文和完整安装态验收。
- [当前阶段计划](proposed/integration/2026-09-07-world-portable_workspace-web.md) 仅维护后续事项和未决验收要求。
- [Research 维护收敛](implemented/architecture/2026-09-11-research-maintenance.md) 记录当前唯一状态格式、执行身份拆分、展示订阅、补丁缩减和统一验证入口；替代早期记录中的自动迁移策略。
- [补丁审计](archived/2026-09-patch-audit/2026-09-07-patch-surface.md) 保留早期静态范围推导，不是当前补丁清单或实现保证。
- [本机与 SSH 工作区验收](implemented/integration/2026-09-11-local-workspaces.md) 记录显式本机身份、原生历史迁移、混合隔离与安装态验收。
- [DSH 0.1.5-rc.1 适配验收](implemented/integration/2026-09-10-dsh-rc1-upgrade.md) 记录原生文档预览、World 路由、导航生命周期、子 Agent catalog 与安装态回归。
- [DSH 0.1.5-alpha.1 适配验收](implemented/integration/2026-09-09-dsh-upgrade.md) 记录范围读取、文件预览、V2/V3 和新版安装回归。
- [远端附件验收](implemented/integration/2026-09-10-remote-attachments.md) 记录远端持久源、按需模型/预览读取、旧引用边界和安装态上传回归。
- [原生 bundle 交付](implemented/integration/2026-09-08-native-bundle-delivery.md) 记录替代源码启动的决定、安装验收和后续修复。
- [子 Agent、终端与源码交付验收](implemented/integration/2026-09-08-child-terminal-source-acceptance.md) 记录续接、真实模型和无 scaffold 的原生 CLI 交付。
- [Skills 与消费者验收](implemented/integration/2026-09-08-skills-consumers-acceptance.md) 记录本轮实现、测试及独立 review 的范围。
- [Web/SSH 验收](implemented/integration/2026-09-07-web-ssh-acceptance.md) 记录受限 profile、4 包补丁、浏览器闭环与未覆盖范围。
- [双 World E2E 环境](implemented/integration/2026-09-07-e2e-environment.md) 记录 Docker/SSH 验收及浏览器边界。
- [Session 准入补丁](implemented/integration/2026-09-07-session-admission.md) 记录首个源码切片与验收边界。
- [仓库与子系统结构](implemented/architecture/2026-09-09-package-subsystems.md) 汇总目录决策与迁移验收。
- [早期集成决策](archived/2026-09-initial-integration/2026-09-07-decisions.md) 汇总已被替代的 no-patch、单 World 和延期 Web 方案；同目录保留各子系统验收及原始 evidence/。

实现落地时更新对应 docs/，计划删除已完成待办；只有重要决定或新验收才保存独立 note。验收记录描述当时结果，不随代码重写；被替代的决定注明后继记录。原始 JSON 不改字节，新结果另存。修复记录并入相关验收，目录整理合并为结构决策；普通操作过程留在 Git 历史中，不另维护流水账。删除或移动文件时修复链接。
