# Agent Notes

Notes 记录尚在演进的计划、设计取舍、实验和证据；docs/ 记录稳定的架构、契约与当前使用方式。参考 DSH 的 lifecycle/class/date-topic 组织方式，采用单语文件，不复制其整套文档工具链。

```text
proposed/integration/        已选方向或待决方案，仍未完成实现
implemented/architecture/   已落地的结构/设计决策，事实随代码维护
rejected/                   被否决且仍有防止重复试错价值的方案（按需创建）
archived/                   被替代的历史记录与原始验收证据
```

文件名为 `yyyy-mm-dd-topic.md`。活跃 note 包含标题、`Status: proposed|implemented|rejected`、问题、方案/决定、真实替代方案、验收/后果。proposed 表示尚未完成，不表示用户尚未同意方向。按阶段更新当前计划，不叠加多个互相矛盾的 next-stage 文件。

- [验收一页纸](proposed/integration/2026-09-08-assumptions-and-workarounds.md) 集中维护重要假设、workaround 和 review 限制。
- [当前阶段计划](proposed/integration/2026-09-07-world-portable_workspace-web.md) 是执行顺序和未决项的唯一入口。
- [补丁审计](proposed/integration/2026-09-07-patch-surface.md) 是静态范围证据，不是实现保证。
- [DSH 0.1.5-alpha.1 适配验收](implemented/integration/2026-09-09-dsh-upgrade.md) 记录范围读取、文件预览、V2/V3 和新版安装回归。
- [子 Agent、终端与源码交付验收](implemented/integration/2026-09-08-child-terminal-source-acceptance.md) 记录续接、真实模型和无 scaffold 的原生 CLI 交付。
- [Skills 与消费者验收](implemented/integration/2026-09-08-skills-consumers-acceptance.md) 记录本轮实现、测试及独立 review 的范围。
- [Web/SSH 验收](implemented/integration/2026-09-07-web-ssh-acceptance.md) 记录受限 profile、4 包补丁、浏览器闭环与未覆盖范围。
- [双 World E2E 环境](implemented/integration/2026-09-07-e2e-environment.md) 记录 Docker/SSH 验收及浏览器边界。
- [Session 准入补丁](implemented/integration/2026-09-07-session-admission.md) 记录首个源码切片与验收边界。
- [结构维护](implemented/architecture/2026-09-07-repository-layout.md) 记录本次已落地整理及验证。
- archived/2026-09-initial-integration 保存此前分散文档及 evidence/。旧 no-patch、延期 Web 等决策已被当前方向替代，不能覆盖用户新指令。

实现落地时更新 docs/ 的当前行为，将对应独立 note 移到 implemented；未完成的阶段保留 proposed。归档记录冻结为历史，原始 JSON 不改字节；新验收另存新记录。重命名/移动时同步修复链接，代码事实变动时更新活跃和 implemented notes。删除没有持续价值的中间草稿，不维护重复的每日状态表。
