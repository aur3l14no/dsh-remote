# Agent Note: World-qualified DSH Web

Status: proposed

## Problem

现有执行 providers 和 binding fixture 已工作，但原生 Web 的本地 mkdir、冷恢复准备缺口、path-only Workspace 与非工具消费者阻止可靠的多 World 项目体验。用户已选择下游补丁 + 外部插件路线，要求先整理目录、维护责任、文档和执行边界。proposed 标记工作尚未完成，不是重新等待方向批准。

## Proposal

交付本地 DSH Web 中可选择 World×workspace 的项目，保留原生 Agent、Session 与对话，所有受支持的 workspace IO/进程在绑定 World 中执行。固定当前 DSH revision，维护窄补丁和显式 profile；不等待上游 PR，不使用 Fake Project，不改 Session JSONL schema。

Rust helper、client/SSH 库、DSH 集成分层已经确定；当前代码和状态以 README/docs 为准。series.json 为空，不得把包级审计写成已实现补丁。

## Stages and dependencies

| 阶段 | 工作与输出 | 退出门槛 |
| --- | --- | --- |
| M0 结构维护（已完成） | runtime/{helper,client,ssh}/、integrations/dsh/；精简 docs；notes lifecycle；迁移 imports/build/package 声明 | 根 Cargo/npm、DSH 类型检查、bundle/package consumer 和文档链接通过；原始 JSON 保真 |
| M1 执行边界准入 | 按 consumer 清单确定 local control / explicit local connector / remote workspace；定界 skill 指令、脚本、依赖和 transfer | 不依靠名称黑白名单或提示词猜执行环境；每个启用 consumer 有 Agent/World 选择依据；缺失本地脚本不会被偷偷本地运行 |
| M2 Host admission 补丁 | api-session-controller 中 create/adopt/resume/observed promotion/upload lookup/fork；独立 patched-host 脚本及有序 patch | 持久 World 绑定先于执行；覆盖同 ID 并发和 raced adoption；远程目录不被本地 mkdir/realpath；原本 local Session 行为有回归 |
| M3 Project 插件与 Web | 产品化实验 registry；补 rename/delete/reorder/archive；实现 API/feed 与 UI/navigation，保留 uiWorkspace/useWorkspaces | 两 World 同路径列表并存，增量与重连一致；直接深链接、重启恢复、创建、fork 真实浏览器闭环 |
| M4 远程编码消费者 | tool-fs、policy、instructions；remote skill/file-reference；terminal/jobs 初始化与 owner 清理；明确本地能力 | 远端 AGENTS/skills 生效、本地全局指令不误读远端；并发不同 World，无本地同名路径副作用；shell/cancel/子 Agent 继承与非工具阶段通过 |
| M5 可维护开发者发行 | 可复现 patched host + 外部包 + profile；产物校验、兼容矩阵、setup/resume 指南 | 真实模型远程读/搜/改/测，SSH 断线/重启，安装态 browser 验收；发布说明不夸大平台和附加能力 |

M1 必须先定 consumer 范围；M2/M3 是同一用户链路的后端和前端；M4 是可用编码门槛，不可以“Web 打开了”替代。每完成阶段就改本 note 与相关 docs，只保留最新未决项。未实施步骤不创建空 plugin 或伪造可运行 profile。

## Patch / plugin ownership

优先维护 4 个源码补丁候选：api-session-controller、tool-fs、sandbox-policy、agent-instructions。后三者的最终补丁/外部 provider 分工由 M1/M4 实验确认。5 个外部替代职责为 Workspace registry、Workspace API/feed、Workspace UI/navigation、远程项目 skill provider、file-reference provider。

新 patch 必须记录包/源文件、准入输入、失败行为、local profile 回归和专门测试；只能在通过 patched-host gate 后进入 series.json。保持 unchanged-source 验收独立，不能删除脚本中的 dirty/revision guard 伪装兼容。

新增 Project 插件落在 integrations/dsh/plugins/，不把未产品化 registry 留在 experiments 充当发行入口。experiment 在迁移前保留为负例和证据，成熟行为迁移后删除重复实现或保留明确小型 seam fixture。

## Execution decisions to close

1. 非 tools/execute 阶段以 Agent/owner 显式选择具体 provider，不依赖一个默认 World。列清 pre-step、skill catalog、file-reference、terminal 初始化、job 回调和 disposal 的传播点。
2. 本地 user/bundled skill 与远程 project skill 各自发现；内容的来源不会赋予本地 Shell 权。定义可支持的能力要求和不兼容报告；第一版不实现任意本地 CLI skill 自动执行。
3. 本地网络连接器保持本地独立 service/tool，远端 workspace Shell 保持远端。当前没有 web search 安装或验收证据，M1 必须选择并验证实际需要的连接器才可宣称支持。
4. 若某 skill 需要本地脚本处理远端文件，第一版应明确不支持或采用专门 API + 显式 transfer；不可自动上传任意路径、同步凭据或改写 shell 文本。
5. bootstrap 本地控制命令不是模型可调用的 host-shell。保持 SSH 验证、目标账号权限和不复制本地 env 的机制。

## Edge-case acceptance matrix

| 反例 | 预期 |
| --- | --- |
| 两 World 相同 cwd、不同文件与指令 | Project/Session、工具输出、AGENTS 和 skill 结果不混淆 |
| 本地同名目录或 symlink | 不能成为远程 path resolution、policy root 或失败回退的来源 |
| cold deep link、history follower、upload-first | 保存绑定驱动准备；先准备再执行，UI 活动顺序不改变 World |
| 不同 Project 并发请求相同 Session ID | 精确冲突，catch/race 不接管错误 World |
| Web fork、子 Agent、子 Agent continuation | 对应 lineage 和 binding 正确，过滤/取消由 DSH 原生机制保留 |
| 本地 skill 写绝对本地脚本路径 | 明确不可用；不改向 host、不自动复制/解释本地路径 |
| 本地连接器需要远端文件 | 传递的是明确选择的数据，执行地点与副作用清晰 |
| 回调/初始化不在 ALS 工具链 | 有显式 owner provider 或失败，不默认 local/first World |
| 丢 binding、配置改向、容器消失、断线超时 | 执行阻止，识别历史 World，无静默重试到新环境 |
| 新 runtime、取消/响应丢失 | 不重放未知结果的旧命令；确认清理与请求已接受明确区分 |

## Web Search 重点验收

优先级：作为 M1 的必选连接器边界验证，并在 M4 完整 consumer 装配和 M5 安装态验收中回归。状态：待选择实际连接器并实现测试；当前没有 Web Search 通过证据，不能用 grep/glob 文件搜索代替。

| 测试 | 必须观察到的行为 |
| --- | --- |
| 本地网络 API 与远端 Shell 网络命令 | 同一 Session 调用实际 Web Search 连接器和 Shell HTTP 探针，分别记录本地请求入口和目标 World 的执行证据；不能只凭工具名或正文判定地点 |
| 远端不能访问搜索服务，本地可访问 | 连接器仍可搜索，远端 Shell 请求按目标网络条件失败，不能改向本地；仅针对测试端点限制访问，不改变远端公共网络配置 |
| 两个 World 并发搜索与项目读写 | 搜索结果回到正确 Session，后续读写使用各自 World；同名 cwd 不串线，本地同名目录无副作用 |
| 凭据与项目数据边界 | 使用测试凭据，确认其不进入 helper 请求、远端 env/文件或公开产物；连接器只接收明确提供的查询/数据，不自动上传 workspace |
| 连接器超时、失败与取消 | 返回明确错误或取消结果，不重试到远端 Shell，不扩大为本地通用 shell 权限，不改变 binding；恢复后的远端操作仍指向原 World |
| 本地 skill 搜索后操作远端项目 | 通过明确本地连接器搜索、远端 provider 读写；本地脚本路径不赋予本地 shell 权，也不能作为隐式 transfer |

测试分两层：M1 使用实际连接器实现接入可记录请求的受控 HTTP 服务，验证路由、凭据及错误；M5 在安装后的 profile 中使用真实搜索服务与 Linux/SSH World 完成端到端任务，记录连接器版本、装配配置、执行地点和取消行为。测试替身不能替代真实服务可用性证据，原生 macOS fixture 不能替代 SSH 验收。测试代码归入 integrations/dsh/tests/，阶段记录进入 notes；未通过前保持“不支持/未验收”的描述。

## Deferred boundaries

准确的 session-reference 同项目排序、严格子 Agent pre-publication 原子提交、任意附件同步/远程预览、LSP/Git 扩展、跨根 Agent 消息、完整远程 sandbox、外部 Agent 后端、公共自动下载与安装 GC 不默认为第一版支持。若必需消费者要求改 Agent loop/Session schema 或通用对话协议，先重新定界并记录具体调用点。

## Alternatives considered

**纯外部插件且不改 DSH。** 原生 Web 创建和冷恢复绕过准备，已被实验复现；不继续用 CLI 降级代替用户选择的完整 Web 方向。

**Fake Project。** 占位 cwd 会引入两种路径语义并影响指令、shell 和本地消费者；不作为本阶段身份方案。

**自建或迁移 Harness。** 现有原生 Agent/Session 接口足以继续做局部补丁验证，暂不承担替换模型循环和对话引擎的成本。

## Acceptance criteria

阶段完成以真实可复现的行为与安装态证据为准。静态审计、控制器 fixture、tarball import、原生 macOS helper 测试分别只证明自身范围。至少两个 World 同路径，保持模型/历史本地，远端代码读写与测试、重启恢复、子 Agent 与取消成功；缺少 World/脚本/依赖有可理解的明确失败。

## Risks

上游预览 API 变化、WorkspaceFeed 存储耦合、跨 World 同路径缓存键、非工具路由、附件执行路径和 local policy canonicalization 是重点风险。9 个职责不是最终包数上限。补丁需带 local 行为回归；支持集合之外的可信插件仍能直接调用本地 Node API，这不是 sandbox。

## Evidence

- [包级审计](2026-09-07-patch-surface.md)
- [执行边界](../../../../docs/execution-boundaries.md)
- [原始 Project 验收](../../archived/2026-09-initial-integration/evidence/project-worlds-acceptance-results.json)
- [原始 session-routing 验收](../../archived/2026-09-initial-integration/evidence/binding-acceptance-results.json)
