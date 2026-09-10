# Agent Note: DSH 下游补丁与包覆盖审计

Status: archived

历史审计：下文冻结早期候选范围；当前实现以 [series.json](../../../../integrations/dsh/patches/series.json) 和 [系统全景](../../../../docs/system-map-1.md) 为准，不继续更新当时的包数推导。

日期：2026-09-07。研究结论，尚未实施补丁或完成 Web 验收。此文重新评估此前“不修改上游”的实现约束，不自动改变已有交付状态。

## 结论与计数口径

审计基线为本地干净 checkout `d347e703908d0406b7a7ef80e3a0e594d86b2215`，路径 `/Users/y/portable_workspace/OSS/deepseek-harness`。阅读了实际实现、默认 Web/standard profile 和本项目实验。不是对所有 DSH 插件的兼容性保证，也不是对最新版的发布兼容声明。

**World-qualified Web 项目与正常文件操作涉及 5 个原生包的职责：建议 2 个源码补丁，3 个由外部 portable_workspace 实现接替。** 这不包括现有 FS/subprocess provider 替换。若计入远程编码常用的 policy、项目指令、技能和文件补全，建议按 **9 个原生包职责** 规划适配；其中采用本文建议时是 **4 个源码补丁候选、5 个插件替换候选**。包数是架构工作清单，不是已编译验证的最小值。

保留跨 Session 引用的准确 World 语义时再加 `dsh-session-reference`；若要求子 Agent 绑定失败绝不能发布，再单独评估 `dsh-subagent`。附件进入远程执行环境、完整远程 sandbox、LSP、外部 Agent 后端等不包含在这 9 个中，不能宣称默认 Web 全功能兼容。

## 5 个基础包

| 原生 npm 包（均以 @deepseek-ai/ 开头） | 建议方式 | 必须处理的职责 |
| --- | --- | --- |
| `dsh-api-session-controller` | 源码补丁 | World 准备、创建/接管身份验证、所有冷恢复、Web fork、远程路径的本机打开策略 |
| `dsh-tool-fs` | 源码补丁 | 去掉工具层对远程路径的本地 canonicalPath；保持远程 symlink/parent-path 语义 |
| `dsh-workspace` | 外部 registry 替换 | World×canonical cwd 身份、状态、Session 成员、加载恢复、归档与排序 |
| `dsh-api-workspace-controller` | 外部兼容 controller 替换，或等效补丁 | 携带 World 的创建 API、与新 portable_workspace 存储一致的实时 feed |
| `dsh-client-ui-workspace` | 外部 UI/navigation 替换，或等效补丁 | World 选择、远程路径输入/浏览、环境标识；保留 uiWorkspace/useWorkspaces 等消费者契约 |

替换包意味着在 profile 中不装配原实现，并由外部实现提供所需服务/槽位。不是修改已经加载对象的私有字段。一个外部 portable_workspace 包可以承担后三行，但维护的原生职责仍然是三项。

### Session Controller：分支多，但集中在一个包

主要源码入口：

- `packages/api/session-controller/src/commands.ts`：`create` 选择 workspace 后仅把 cwd 传给 `ensureSession`；`fork` 直接调用原生 `agents.create`；`forkWorkspace` 优先按 Session 成员及祖先查找。
- `src/agent.ts`：`ensureSession`、`createOrAdopt`、`resumeObserved`、`composeAgent`、Typert Agent/Session lookup。
- `src/index.ts`：上传 resolver、历史 promotion、本机 openWorkspacePath。
- `src/history.ts`：快照读取后将 retained observation 提交 promotion；无需仅为了准备 World 改写历史流。

| 用户入口 | 实际激活路径 | 补丁要求 |
| --- | --- | --- |
| 新建项目 Session | commands.create → ensureSession → createOrAdopt → 本地 mkdir → agents.create | 把选中的 portable_workspace 身份保留到准备层；远程创建不经过本地 mkdir |
| 带已有 ID 的创建/接管 | createOrAdopt 的 live 分支，或持久化检查后 agents.resume | 不能仅凭 cwd/preset 相同放行；核验持久 World 绑定 |
| prompt、改模型、rename 等冷操作 | commands.resolveAgent → agent.resolveAgent → resumeObserved | await 保存的 World 准备后再发布 |
| 直接打开历史链接/重启后订阅 | history.follow → index.promote → resolveObservedAgent → resumeObserved | 和普通冷恢复使用同一准备服务 |
| 原始文件上传 | fileUploads resolver → agent.resolveAgent | 激活准备可由同一补丁覆盖；附件搬运是另一件事 |
| Typert Agent/Session 参数解析 | agent.ts 独占 lookup → resolveAgent | 不再添加第二个 lookup resolver |
| Web fork | commands.fork → composeAgent → agents.create | 依据源 Session 的持久 World 绑定新 ID；不能依赖子 Agent 的 origin= subagent 继承逻辑 |

建议在该包增加可注入的环境准入服务，输入操作种类、Session ID、选定 Workspace ID 或源 Session ID、cwd/preset；外部实现负责查找 portable_workspace、远程校验和准备、提交不可变绑定。原生控制器仍负责模型选择、请求序列化和调用 Agent APIs。不要让这个包依赖 SSH/helper 实现。

准备必须覆盖本地 mkdir 之前的创建分支，也必须进入 create/resume 的装配顺序。仅在 composeAgent 中加调用不足以解决先执行的 mkdir；仅在 commands.create 中加调用不足以覆盖恢复和 fork。相同 ID 的并发创建/恢复，以及 catch 后采纳 raced live Agent 的分支，必须重新验证绑定，不能把原有 cwd 校验当作完整身份检查。

冷恢复以 Session 的持久绑定为权威，不以 UI 当前选择或最近 portable_workspace 为权威。Root 绑定可以沿用现有“先提交选择，创建失败后保留同 World 重试”的语义；不承诺与 JSONL 存储跨文件原子提交。portable_workspace 被删除、World 配置变更、断线、缺失 binding 的行为必须显式定义。

`openWorkspacePath` 当前直接用本机 opener 打开请求路径。远程 profile 可关闭该功能；若保留，需要在同一个包内进行环境识别/外部打开策略适配，不能把远程路径传给 Finder/本地编辑器。

### Workspace：实验不是完整 registry 的替代品

`packages/workspace/workspace/src/index.ts` 的 create、resolveByPath、启动 header index 与恢复依赖本地路径。`entity.ts` 的成员与状态同样需要 World-aware 行为。本项目 `integrations/dsh/experiments/portable_workspace/registry.ts` 已验证两个 World 的相同路径，但 rename/delete/reorder/archive 仍显式不支持，完整 Web 需要补齐它们以及活跃成员维护。

新发现：`packages/api/workspace-controller/src/feed.ts` 的 `changed()` 硬编码 `change.domain === 'workspace'`，解析原生 `workspaceDomainState`/`workspaceRecord`，监听 `workspaces` 表。实验使用的是 `兼容存储域（见实验实现）` 域。即使初次 baseline 能由替代 registry 生成，原生增量 feed 也不会自然跟随新的存储。必须改造 feed 或替换 controller，不能声称仅替换 registry 即可。

`WorkspaceCreateRequest` 只有 path；`commands.create` 调用 `resolveByPath(path)`，无法区分同路径的不同 World。可以新增外部 World portable_workspace 创建 API，返回兼容 WorkspaceView；也可以扩展原 API。保留旧 frame 结构、让新 UI 单独查询 World 元数据，有机会避免广泛修改通用 Session/Conversation 客户端类型。

### UI：不必重写对话，但有接口需要保留

`packages/client/ui-workspace/src/client/contract/slots.ts` 中 directory-flow 的 `onPicked(path)` 与 `createWorkspace({path})` 无 World 信息，不能只换 directory picker。

可以接替 `sidebar.workspaces` 和 `conversation.hero.workspace`，但原生 `ui-conversation` 还注入 `uiWorkspace` 并使用 `useWorkspaces` 和按 workspaceId/sessionIds 定位项目。新实现必须保留 navigation、snapshot hook 与 blank Session 的连接语义。否则 `dsh-client-ui-conversation` 会成为额外修改包。

World/远程浏览可以走新的 portable_workspace API，不必让原生 host-directory-picker 支持 SSH。禁用其原生选择器装配，属于 profile 变更。若一定要复用原生 picker 协议，则 picker 的接口、provider、UI 是另一组扩展，未计入 5 包方案。

## 常用远程编码的另外 4 个职责

| 包 | 已确认事实 | 建议 |
| --- | --- | --- |
| `dsh-sandbox-policy` | `resolveWorkspaceRoot` 无论模式都调用本地 canonicalPath；它会 realpathSync.native，同路径本地 symlink 可改变远程根 | 候选第 3 个源码补丁：使 root 来自已准备的 World，或替换 policy provider。SSH 权限模型不等于本地 sandbox；不能只配置 danger-full-access 就认定路径无本地访问 |
| `dsh-agent-instructions` | 已支持 FS provider；但 agent/pre-step 的 compose 从共享 ctx.get('fs') 读取，不在当前 tools/execute ALS 内。发现逻辑还把 dshHome 全局指令交给同一 provider | 候选第 4 个源码补丁：逐 Agent 选择具体 FS，并明确本地全局指令与远程项目指令来源；保留原生日志/版本与重放机制。外部事件路由可能替代部分改动，但未证明覆盖完整异步链 |
| `dsh-skill-filesystem` | 项目根探测部分使用 FS；目录扫描、正文和 watch 仍使用 Node 文件 API；项目与本地/内置 skill 根混在同一 provider | 替换远程项目 skills provider，保留技能 registry/tool 与有意使用的本地全局技能；不能直接让现有默认根扫描远程 cwd |
| `dsh-file-reference-local` | @ 文件候选按 Agent 缓存，但 WorkspaceFileSearch 直接用本地 lstat/readdir | 替换 provider；接口 list(agent, query, signal) 已携带 Agent，可直接选择 World，无需为此修改 file-reference service 或 Session API |

这 4 项加上基础 5 项，是“9 个职责”的口径。若只交付不带技能/@补全的受限 Web，可以少做后两项，但必须在产品上移除相应功能。项目指令读取失败会影响编码语义，不能用静默缺失代替兼容。

## 额外功能与不能混入基础计数的风险

- `dsh-session-reference`：`sameWorkspace` 与排序只比较 header.cwd。保留该功能会把两个 World 的同路径任务标记成同一 workspace；需增加 World/portable_workspace identity resolver、替换 provider，或关闭此功能。这不是跨根消息服务。
- `dsh-subagent`：子 Agent 已继承父 cwd/preset，本项目已验证普通继承与工具过滤。现有绑定在 session-start 落盘，失败后 Agent 可能已发布但执行被阻止。如要严格 pre-publication 提交，需要在该包 child setup 的创建/continuation 恢复链加入 awaited admission；检查全部 setup 调用，不必先修改 core agent-loop。Web fork 不等于此子 Agent 路径。
- `dsh-client-file-upload` 与 `dsh-attachment-local`：上传字节留在本地附件存储符合 Session/模型留本地的目标；激活由 Session Controller resolver 覆盖。但是“附件已经上传”不等于“远程 Shell 能读”。LLM 的 `fileReadPath` 调用 FS 的 `processPathFromHostPath`；远程 provider 没有已证明的附件发布映射。若支持远程工具处理上传文件，需要异步传输、按 World 缓存与路径映射，单独验证是否必须增加附件/请求准备钩子。不要先改 LLM 包或把本地附件路径直接暴露为可读远程路径。
- `dsh-terminal-bash`、`dsh-bash-local`、`dsh-tool-bash*`、terminal/jobs 服务：很多执行已通过 subprocess，不能按包名中的 local 判定必须重写。已有 terminal fixture 用真实消费者和具体 provider 跑通，但单共享 preset 的 initialization/background 路由仍未验证。可尝试利用 terminal backend 的 owner 参数在外部选定具体 World。不能据 fixture 宣称默认 Web 整组无改动可用。
- 本地 `fs-sandbox`、`bash-sandbox`、平台 sandbox runner 不应直接远程化使用；使用远程 FS/subprocess 与既定 SSH 权限/独立审批模型。保留完整远程 confinement 是新需求，不能通过改文案声称已实现。
- LSP、Git 扩展、workflow、自修改/插件开发、外部 Codex/Claude/ACP/SDK 子 Agent 后端不在此审计的受支持消费者集合内。开启每一项都需独立检查本地 IO、进程和生命周期；不承诺任意第三方插件兼容。
- Windows 本地主机管理 POSIX World 时，还需审计消费者 node:path 的平台语义；此处以现有 macOS/Linux 验收基础规划。

## 暂无必要修改的内核与基础设施

按上述分工，尚未发现必须修改 `dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-session-persistence`、`dsh-session-query`、`dsh-tools`、`dsh-agent-presets`、LLM/model adapter、Cordis 或 Typert 的理由。原生 create/resume 已支持 awaited setup；外部 binding 可以承载执行身份，Session.header.cwd 保持真实远程路径，无须为第一版修改 JSONL schema。

通用 `ui-chat`、`ui-session`、`ui-conversation`、连接/网关/HTTP 层可争取保持源码不变；前提是新 portable_workspace 层保留它们实际消费的接口。保持不变是设计目标，不是已完成的浏览器验证。

FS/subprocess 的 Service Definition 无需因为远程实现而重写。外部 provider、managed ripgrep 映射、runtime/SSH 已存在于本项目，属于已有替换成本，不重复算成新增上游补丁。

## 代码改动与构建影响不同

推荐固定一套 source-built 基线：维护独立补丁队列和外部插件，使用一个远程专用 profile/preset。profile、bundle 选择是配置覆盖；不需要为了变更 row 去 fork `dsh-web-app`/`dsh-base` 的业务代码。

包的 Host/Client 两面、类型声明和 Typert Remote 图可能需要重新生成、构建。扩大原生请求/响应类型可能影响 api-remotes/client 和客户端类型检查；新增外部 API 或保持既有 frame 可减少传播。重新构建多个包不等于维护多个包的源码 fork，但发布闭包必须整体验证。本项目脚本目前主动拒绝非基线或有修改的 DSH checkout，未来应新建专用 patched-host 验证入口，不要削弱现有 unchanged-baseline 验收。

## 下一步验证顺序

1. 在隔离 checkout 中做 Session Controller 准入补丁；使用现有 portable_workspace registry 和绑定服务。验证新建、显式 ID 接管、冷恢复、历史 promotion、上传触发激活、Web fork 及相同 ID 并发。错误必须不创建本地远程同名目录、不采纳另一 World 的活跃 Agent。
2. 完成 portable_workspace registry 操作及兼容 feed，接入 World 选择 UI/navigation。两个 World 的相同路径必须同时出现在列表，增量更新与重连后一致。
3. 修复 tool-fs parent-path 和 policy root。用本地同名但不同 symlink/内容的目录作反例，证明操作在远程解析。
4. 验证 instruction/skill/file-reference、terminal/jobs 的逐 Agent 路由；两 World 并发，包含模型 pre-step、后台回调和清理。
5. 最后运行真实 DSH profile 的浏览器闭环和真实模型 smoke。包括直接深链接、进程重启、World 缺失/配置变更、原生子 Agent、fork。控制器 fixture 成功不作为 Web 完成证明。

退出条件：若为了通过这些门槛开始修改 Agent loop、Session 格式或通用对话引擎，重新评估分工；这代表实际范围超出了本审计提出的边界，不能以“顺便”扩张。

## 证据索引

所有上游路径相对前述固定 checkout；可以在 [固定上游基线](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215) 查看：

- 激活：`packages/api/session-controller/src/{agent,commands,index,history}.ts`。
- 项目：`packages/workspace/workspace/src/{index,entity}.ts`；`packages/api/workspace-controller/src/{commands,feed,types}.ts`。
- UI：`packages/client/ui-workspace/src/client/{index,navigation}.ts`、`contract/slots.ts`；`packages/client/ui-conversation/src/client/{apply.ts,skeleton/ConversationRoot.tsx}`。
- 文件/策略：`packages/fs/tool-fs/src/session-cwd.ts`、`sandbox.ts`；`packages/sandbox/sandbox-policy/src/index.ts`、`packages/sandbox/sandbox/src/roots.ts`。
- 上下文：`packages/context/agent-instructions/src/{index,files}.ts`；`packages/skill/skill-filesystem/src/index.ts`；`packages/context/file-reference-local/src/{index,search}.ts`；`packages/context/session-reference/src/index.ts`。
- 继承：`packages/subagent/subagent/src/{child-agent,continuation}.ts`。
- 附件：`packages/client/file-upload/src/index.ts`；`packages/attachment/attachment-local/src/index.ts`；`packages/llm/llm/src/index.ts` 的 fileReadPath；`packages/fs/fs/src/index.ts` 的 processPathFromHostPath。
- 执行：`packages/terminal/terminal-bash/src/index.ts`；`packages/shell/bash-local/src/index.ts`。
- 实际默认装配：`packages/bundle/web-app/cordis.patch.yml`；`packages/preset/agent-presets/presets/standard/agent.cordis.yml`。
- 本项目证据：[portable_workspace 实验](../../../../integrations/dsh/tests/integration/README.md)、[测试](../../../../integrations/dsh/tests/integration/portable_workspace.ts)、[Linux 两容器验收记录](../../archived/2026-09-initial-integration/evidence/project-worlds-acceptance-results.json)、[terminal fixture](../../../../integrations/dsh/tests/integration/terminal-consumers.ts)、[当前路由](../../../../integrations/dsh/packages/world/ssh-world/src/routing.ts)。

验证说明：本次是源码与既有验收证据审计，未执行补丁构建、浏览器测试或重新运行远程验收；未改动上游 checkout，也未改变已有实现。
