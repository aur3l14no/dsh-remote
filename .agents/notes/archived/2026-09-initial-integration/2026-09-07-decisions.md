# 早期集成决策摘要

Status: archived

历史基线：未修改的 DSH `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-05 至 09-07。汇总原 delivery-plan、next-stage、demo-assessment、upstream-seams 和 web-world-selection；旧方案已被[下游补丁与 Web 集成方向](../../proposed/integration/2026-09-07-world-portable_workspace-web.md)替代，不作为当前待办。

## 当时的发现与决定

| 发现 | 当时选择与原因 |
| --- | --- |
| Web 创建在 preset 前调用本地 mkdir，冷激活缺少 World 准备 | 暂停完整 Web 集成，尝试显式 bind/prepare 后调用原生 Agent API；不复制 Agent factory 或 Session 存储。后续由 Session admission 补丁解决入口缺口。 |
| 原生 workspace 按本地 canonical path 标识，创建请求不携带 World，feed 绑定原生存储域 | 实验外部 World × workspace registry；仅加目录选择器不足以实现完整隔离。原计划的设置/UI 暂停决定后来被完整 Web 方案替代。 |
| 多个 World 共享 preset 时，初始化和非工具调用缺少明确环境 | 曾提议首版一 World/workspace 一宿主进程；这是降低初期装配范围的备选，不是最终多 World 设计。 |
| 原生 send_message 面向 parent/child，实验 Teams 也在 lead 的共享 workspace 下创建 child | 暂停“一个根 Agent 协调跨 World 独立 Session”演示，不自行引入跨根邮箱或 Agent 管理器。Web 能创建独立 Session 不代表存在模型可调用的跨根通信。 |
| tool-fs 的 parent traversal 调用本地 realpath；child 的 session-start 通知不能否决发布 | 当时拒绝受影响路径；绑定提交失败的 child 保持执行阻止。后续路径补丁与严格 child 发布前提交分别处理，不能混为一个已解决问题。 |
| 对应源码版本的公开 npm 包不完整 | 初期只承认 source fixture/tarball Loader 验收；完整官方 CLI 安装另设门槛，后来由原生 bundle 交付替代。 |

## 仍有解释价值的取舍

先以真实 profile 完成远端读写、搜索、执行、取消和 Session 恢复，避免用 helper 单测或 UI 展示代替产品闭环。关键消费者绕过 World 时应停下重新定界；不通过 FS monkey-patch、伪本地目录、私有 controller 字段或新 Harness 掩盖接口缺口。

曾将更换宿主列为核心执行能力无法满足时的备选；没有启动迁移或自建 Harness。自动发布、可信下载、通用 resolver 链、远端 sandbox、附件搬运和 worktree 编排当时均不属于已交付范围；今天的支持范围见[系统全景](../../../../docs/system-map-1.md)。

## 原始证据与后继记录

- [项目实验 JSON](evidence/project-worlds-acceptance-results.json)：显式准备后的创建/恢复及未准备 Web 入口缺口。
- [持久 Session 路由](session-routing.md)、[终端](terminal.md)、[低层打包](packaging.md)：当时的实现与证明范围。
- [Session 准入](../../implemented/integration/2026-09-07-session-admission.md)、[Web/SSH](../../implemented/integration/2026-09-07-web-ssh-acceptance.md)、[原生 bundle](../../implemented/integration/2026-09-08-native-bundle-delivery.md)：替代上述阶段方案的后续记录。

原始 JSON 保持字节不变。被合并的规划全文可从 Git 历史查阅；本摘要不增加新的验收声明。
