# Session admission: first patched-host slice

Status: implemented

## Problem and decision

原生 Web 控制器在 preset/setup 之前执行本地 mkdir，冷恢复无法等待 World 准备。保留原生 Agent/Session，给 api-session-controller 加可选、可等待的 apiSessionAdmission.prepare 接口；未配置时维持原生本地行为，配置后由适配器负责目录准入，不回退本地。

本切片只维护一个上游包，涉及 admission.ts（新增）、agent.ts、commands.ts、index.ts。workspaceId 和 fork sourceSessionId 传入接口；每个创建调用者先准入，再共享 in-flight 工作，返回 Agent 前复核。准入错误不能被 raced-Agent fallback 吞掉。冷观察激活与 Agent/Session/context lookup 共用恢复入口。准入期间 Agent 被替换时不返回旧实例。

外部 plugins/session-admission 负责 portable_workspace 选择、catalog 校验、远端目录检查、不可变绑定和连接准备。它仍使用实验 registry，未纳入 SSH tarball 或生产 Web profile。失败创建可留下原绑定；同选择重试允许，跨 World 改向拒绝。普通子 Agent 的原有继承规则未改；Web fork 不创建 worktree。

## Alternatives

只在 preset setup 中准备无法防止更早的本地 mkdir。替换 Agent factory 或 Session JSONL 会扩大维护面。把准备错误当成可重试的本地错误会绕过远程身份约束；本实现明确拒绝这种回退。

## Verification and scope

check-patched-host 从固定干净基线导出临时源码，校验并应用 series.json，检查改动宿主包与外部集成类型，然后构建独立 fixture。旧 unchanged-source 脚本和测试保持原入口，仍复现两个原始 Web GAP；用户的上游 checkout 保持干净。

本机真实 DSH Agent、preset、Session JSONL、Typert 和 helper 验收覆盖：

- 直接通过 Web commands 创建和接管两个同 cwd、不同 World 的 Session；拒绝路径无选择的请求且不产生本地 mkdir。
- 同 ID 并发选择与后续错误 World 接管只能有一个有效绑定；已活跃 Agent 也不能绕过拒绝准入。
- 原生 Web fork 在发布前继承源绑定，执行结果与 workspace membership 一致。
- 跨宿主进程冷恢复、并发恢复、冷观察激活和 Agent/Session/context lookup；不需显式实验 prepare 调用。
- World 缺失、catalog 改向、连接不可用、历史绑定丢失均阻止 Agent 发布。
- 未装配适配器时，原生本地创建仍 mkdir，冷恢复无远端绑定或连接。

记录使用 target/patched-host/build.json 与 acceptance.log；这是 native fixture 证据，不是 Linux/SSH、浏览器、真实模型或实际上传 HTTP 验收。上传相关 lookup 已验证，但传输、附件存储及跨环境 transfer 未验收。完整的 SessionController Web 插件装配和 consumer 副作用仍属后续范围。

M1 已固定本切片的 consumer 集合，Web Search 仍未装配/验证，不能将 M1 全阶段标为完成。下一步是宿主完整装配与 portable_workspace API/feed/UI，并继续收敛非工具消费者、local opener、skills 和连接器边界。Worktree 保持延期。
