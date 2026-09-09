# Skills、项目指令与编码消费者验收

Status: implemented

## 问题与决定

远端 portable_workspace 不能从宿主 cwd 推断项目指令和 skill 环境。本轮增加可选原生环境接口，使用外部 provider 做发现；按配置显式部署内容，保留 skill-ops 的文本/exec 分工。替代方案“运行时自动同步整个 home”“开放宿主 Shell”“修改任意 shell 字符串”均不采用，因为不能保持权限和路径语义。

固定 DSH revision 为 `d347e703908d0406b7a7ef80e3a0e594d86b2215`。series 共 5 个补丁、7 个原生包；0005 增加 instruction environment、Session-aware skill lookup 和可关闭缓存，不替换原生解析/调用控制。部署、发现、file references 位于 integrations/dsh/plugins；helper 0.1.2 仅调整通用 spill 记账，不引入 DSH 概念。

## 已完成与证据

2026-09-08，在 macOS 宿主和 OrbStack 两个独立 Linux/SSH World 上运行：

| Gate | 结果 |
| --- | --- |
| Rust fmt / Clippy / build / cargo test；npm check/test | 通过；Node 28 项中 26 通过、2 个显式环境条件测试跳过 |
| 完整 patched Web 构建 | 通过；隔离 checkout，不修改上游源码 |
| 原生 skill/tool-skill/instructions/session-skills 回归 | 4 个文件、231 项通过；4 个参数断言按新增身份/signal 接口更新 |
| 下游 Web plugin 类型；patched-host 源码和双 SSH 行为 | 通过；含原生无适配器 local create/resume 回归 |
| 独立 skills 部署 gate | 两 World，重复部署、内容更新、空目录、缺失依赖、非托管冲突及附带脚本远端执行均通过 |
| Vitest + Playwright Web/SSH | 通过；完整场景摘要见[脱敏 evidence JSON](evidence/2026-09-08-skills-browser.json) |

浏览器场景覆盖：同路径 World 隔离；远端项目/嵌套 instructions；catalog A/B 隔离及更新；skill 工具与附带脚本；文件引用；后台 jobs owner 隔离及 kill；管理界面 rename/order/archive/remove/re-add 保留历史和文件；fork；cold catalog 不创建 Agent；deep link 新 runtime 恢复；缺 binding、World 停止与取消。正常及冷恢复回合各 13 个原生工具调用；额外执行原生 job_kill 验证取消。

宿主 Web Search 使用实际原生 provider、测试凭据和受控 HTTP 端点。远端 Shell 不能访问该宿主 loopback，远端 env 不包含连接器测试凭据。真实模型输出和真实外部搜索未验收，GitHub workflow 定义已扩展但本轮未观察 runner 运行。

命令统一见 docs/development.md；新增部署和原生 context 回归已加入 CI。原始日志和截图位于 ignored target/；长期摘要只保留脱敏 result JSON，不保留 SSH key、binding、私有 target 或 token。

## Review 与后果

用户要求的 subagent 终审已完成。子任务没有可用文件/执行工具，因此主 agent 提供代码片段与实现摘要；审查并非全仓独立读取或独立测试。发现并修复：复制时丢失空目录；共享 HOME 请求的调用者取消不及时；dispose 后扫描继续创建 provider 的窗口。spill 预算复核确认只退还未用预留，并保持完成文件计费。无剩余确定性 P1/P2；扫描中 dispose、并发重复 release 的专项集成竞态测试仍是盲点。

按用户“高不确定性时停止”条件，本轮不扩大为默认远端工具全集：原生 child-agent 委派权限承诺尚无远端 sandbox/policy 对应，且子 Agent 只有继承 binding，skills/admission 使用的顶层 membership 尚未形成完整 lineage 准入。terminal UI、安装态发行、真实服务也未完成。继续工作前先定权限/lineage 契约；不能简单启用本地消费者。worktree 按既有约定延期。

当前契约见 [Skills](../../../../docs/skills.md)，后续 child/terminal 支持见[对应验收](2026-09-08-child-terminal-source-acceptance.md)。

## 同步与取消后续验收（2026-09-08）

实现新 helper 前自动同步及不重启 helper 的手动 Sync Skills；来源由宿主配置，按目标串行，已有 revision 同时验证文件内容和权限。未准入的重连等待响应取消并释放监听器/容量；本地控制传输的取消、超时和输出超限执行 TERM→500 ms→KILL。

当时 npm 为 31 通过、2 个环境选择跳过，根/Web 类型检查、双 Linux SSH 部署和原生 CLI/Playwright 通过。覆盖自动同步失败阻止绑定、修正来源后重试、手动更新保持 helper PID、手动失败保留已部署内容；无需真实模型凭据。原报告为 ignored target/web-acceptance/source-install.json，仅记录历史产物位置。
