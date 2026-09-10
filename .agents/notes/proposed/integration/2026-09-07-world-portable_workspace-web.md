# World-qualified DSH Web：后续工作

Status: proposed

## 当前基线

第一阶段已实现。用户、开发者和 CI 共用官方 DSH + 标准扩展 bundle，源码仅用于构建局部兼容包，不再提供源码宿主安装路径。当前架构与支持范围以 [系统全景](../../../../docs/system-map-1.md) 为准；版本与补丁列表以 [series.json](../../../../integrations/dsh/patches/series.json) 为准。

rc.1 适配、导航与预览重构、子 Agent catalog 提交失败清理已通过[独立复审和安装态验收](../../implemented/integration/2026-09-10-dsh-rc1-upgrade.md)。

World 配置重载、skill 变更预览与确认应用已通过[安装态与双 SSH 验收](../../implemented/integration/2026-09-11-worlds-reload.md)。

本页只维护后续事项和验收要求，proposed 不表示第一阶段未完成。已完成过程见 [原生 bundle 交付](../../implemented/integration/2026-09-08-native-bundle-delivery.md)、[DSH 新版适配](../../implemented/integration/2026-09-09-dsh-upgrade.md)；适配提交 4f3ad28 的 [GitHub CI](https://github.com/aur3l14no/dsh-remote/actions/runs/34304573317) 已通过。

## 尚未完成的范围

| 项目 | 后续工作与边界 |
| --- | --- |
| Local + SSH workspace 共存（当前优先） | 同一 DSH 实例保留 vanilla local workspace，并按 workspace 类型选择执行实现；见下文。E2B 仅为扩展方向，本轮不实现 |
| 连接器鲁棒性 | 补双 Session 并发、超时/失败/取消专项验收；不改变本地连接器和远端 Shell 的分工 |
| 远端 worktree | 明确新目录、portable_workspace、新 Agent 关系与失败清理；见下文，未授权本阶段实现 |
| 附件后续 | 新附件远端持久源与按需宿主读取已实现，见[验收](../../implemented/integration/2026-09-10-remote-attachments.md)；旧引用迁移、存储 GC、跨 World 显式转移另行定界 |
| 远端 OS sandbox | 单独立项；目前父/子 Agent 使用 SSH 账户权限 |
| 发行完善 | 公共 npm/Release、helper 平台矩阵、ripgrep 与可信下载清单、安装 GC；现有 CI 产物不等于公开发布 |
| 其他消费者 | sameWorkspace Session 引用、LSP/Git 扩展、跨根 Agent 消息及外部 Agent 后端需单独适配 |
| 生命周期强化 | 子 Agent catalog 提交失败清理已覆盖；扫描中销毁、并发输出 release 等剩余专项验证继续保留，不得放宽绑定或取消语义 |

## Local 与 SSH workspace 共存（2026-09-11 重新定界）

Status: proposed；用户明确要求重新规划。Local 是必须交付的一等能力。此次修订是方案，不代表已实现或部署。基线为当前工作区与 series.json 固定的 DSH 0.1.5-rc.1。

### 目标与边界

同一实例、同一 workspace 菜单支持 `Workspace = LocalWorkspace | SshWorkspace | …`。LocalWorkspace 保留 vanilla workspace 的本机文件、进程、技能、权限与生命周期行为；SshWorkspace 使用 SSH 环境。E2B 说明类型可扩展，本轮不实现 SDK、配置或空壳 provider。

继续区分三个概念：World 是执行环境，workspace 是该环境中的项目目录，Session binding 固定具体 workspace 与执行身份。用户侧 workspace 类型由其 World/provider 决定，不要求为每种类型复制一套会话系统。`portable_workspace` 是统一的身份/选择适配层，不能继续等同于 SSH 连接或强制 helper。

“本机”指运行 DSH 服务的机器，不是打开浏览器的机器。Local 不是 localhost SSH，不需要 helper、SSH 公钥、Linux runtime 下载或远端技能部署；Mac 本机使用其原生平台能力。该要求不扩大现有 SSH helper 平台矩阵。

### 已确认的耦合与改造位置

- `world/ssh-world/src/bindings.ts` 把 WorldDefinition 写死成 SSH；registry 的 target、路径校验、准入和其他消费者直接导入该类型。
- `world/ssh-world/src/worlds.ts` 同时管理通用 Session binding、Agent 生命周期和 SSH bootstrap/client/provider；连接结果强制包含 helper Client。
- `packaging/extension/cordis.patch.yml` 全局禁用 native workspace、directory picker、本机 FS/subprocess、permission/sandbox 及 local attachments；preset roots 仅保留 remote。
- `bundle/remote` 无条件装配 SSH AccountPolicy、远端 skills 和其他远端消费者。AccountPolicy 还监听全局 sandbox 事件，需要按 Session/执行域限定。
- registry、预览、附件、指令、skills、终端与后台任务都必须纳入混合模式；不能只修改 picker 或 tools/execute。

### 设计决定

1. **通用身份与类型分派**：将 binding、执行环境契约和 Session 路由从 ssh-world 分离到 `integrations/dsh/packages/world/` 下的通用模块；World target 使用带 kind 的联合，首批仅 local/ssh。统一服务按显式类型选择 adapter，SSH 模块保留 bootstrap、Client、远端 FS/subprocess 和 runtime 生命周期。不要让 local 实现伪造 helper Client/info/epoch。
2. **复用 native local**：Local adapter 组合固定上游已有的本机 workspace、FS、subprocess、shell、permission/sandbox、指令/skills 与附件实现。统一 facade/feed 委托 native registry 与 SSH registry 的相应操作，保留原生本机会话历史、workspace 身份和行为；不重写本地文件系统、进程或 Agent loop。具体复用入口在第一阶段核对，缺少可组合接口才增加最小可选补丁。
3. **执行域分开装配**：UI 可以合并 workspace，服务作用域不可混用。Session admission 在初始化、读取项目指令和执行命令前确定 local/ssh 域；preset 选择不能覆盖 workspace 执行身份。保留本机原生策略，SSH 继续使用其账户权限与明确的未支持模式拒绝。移除全局 remote-only 禁用所造成的影响，不简单全局重开 native 服务。
4. **按消费者提供环境能力**：通用消费者获取显式 Session/Agent 所属 FS、进程、路径语义及必要环境事实；附件、技能发现/同步、终端与 watcher 等差异通过相应 adapter/能力入口处理。不承诺 local 与 SSH 能力相同，不先构建通用插件 SDK 或为未实现 E2B 填充假能力。
5. **完整身份与无回退**：新本机会话具有明确 local 身份。旧 vanilla Session 仅从经核对的原生 workspace membership/持久元数据显式采用；缺少 remote binding 或仅有 cwd 绝不自动认定 local。未知类型、损坏身份、不可用 provider 明确失败。fork/child、冷启动、后台任务按保存身份路由，不读取 UI 当前选择。
6. **配置与 UI**：worlds.json 允许 `target: {kind: 'local'}` 与现有 SSH target 共存；本机可默认展示 This computer，并提供原生目录选择，无需用户先手写配置才能使用 vanilla workspace。配置列出的本机目录与原生最近 workspace 合并去重，键包含环境身份和 canonical path，不仅是路径。精确内置 local ID/配置合并规则在实现 schema 时固定并验证冲突；SSH 现有配置继续兼容。
7. **Reload 与 Skills**：目录/catalog 变化对两种类型都可预览。只有具有远端同步能力的 SSH target 执行现有 remote skills dry-run/deploy；local 使用原生本机技能发现，不创建部署副本。local 上的远端部署字段应明确校验拒绝，不默默忽略。已有会话不随 catalog 删除或 target 类型变化改向。
8. **存量兼容**：保留既有 SSH binding 与 registry 身份、历史附件地址和证据路径；schema 需要升级时采取备份、版本化校验与明确迁移，不原地猜测类型。旧本机 Session 的采用规则需真实原生存量 fixture；无法确认身份时明确拒绝并给出可执行的迁移步骤。

### 实施顺序与交付检查

1. 审计固定上游 native workspace create/resume、registry/feed、preset 服务域与可选环境入口，画出 local/SSH 的装配与准入路径；确认可复用的本机服务不被扩展全局替换。用原生 gate 保留 local 基线。
2. 抽离类型与 binding/adapter 契约，先保持现有 SSH 行为和存量格式兼容；将 bootstrap、远端技能同步、账户策略限定在 SSH 域。按实际消费者接口拆分，不做无使用方的抽象。
3. 接入 local 原生执行与 registry，完成 local/SSH admission、fork/child、冷恢复；处理明确的旧本机身份采用和 schema 迁移。
4. 完成混合环境的指令/skills、搜索、jobs/terminal、预览、上传/模型读取/导出和权限隔离；本机保留上游支持能力，远端维持现有约束。
5. 合并菜单与原生本机目录选择，支持 local worlds.json 配置、Reload 和既有卡片展示；保留取消和过期异步响应保护。
6. 构建同一标准扩展，完成下面的安装态验收后再部署。实现完成时更新 docs 当前契约和新增日期验收记录；本计划不提前将 local 标成可用。

### 必须通过的验收

- **原生保真**：无扩展 vanilla 基线、独立 patched-host local gate、装扩展后的 local create/resume/fork/child、目录选择和原生权限/sandbox 行为；本机平台先验收用户的 macOS，不借 Linux fixture 声称 Mac 可用。
- **不触发远端链路**：断网/没有 SSH target 和可下载 runtime 的情况下，本机仍能运行；实测 bootstrap/helper/remote skill deploy 调用为零。
- **混合隔离**：本机 + 两个 Linux/SSH World 同路径不同标记，交错及并发读写/搜索/Shell/后台任务，仅目标环境有副作用。关闭 SSH World 后本机会话继续，远端操作明确失败，无本机回退。
- **非工具入口**：项目指令和技能发现、冷会话文件预览、上传/模型读取/导出、子 Agent 附件与终端 owner 均保留来源；local 不被 remote skills 部署器处理。
- **身份恢复**：各类型的重启、fork/child、catalog 删除/改名/target 类型变更、损坏或缺失 binding、旧 SSH 元数据及原生本机存量采用；不得按 cwd 或缺字段猜测执行地。
- **权限不串域**：本机原生受限模式仍有效，SSH AccountPolicy 不拦截本机事件；SSH 不借 native provider 或本机 skill 获得通用宿主 Shell。
- **官方安装与浏览器**：同一实例切换 local/SSH、创建会话、取消选择、恢复、Reload、置顶归档；真实 macOS local 与双 Linux/SSH 浏览器验收，保留 unchanged-source 与 patched-host 分开的证据。

## 维护约束

新消费者必须说明执行地点、身份来源和缺失上下文时的失败行为。新补丁记录修改包、输入与 local profile 回归，通过独立 patched-host gate 后才纳入 series.json；unchanged-source gate 保留。不可为 skill 提供通用本地 shell、隐式传凭据或改写命令。

保留 Agent/Session 原生实现，不采用 Fake portable_workspace 或复制模型循环。重大接口变化先重新定界；当前契约见[系统全景](../../../../docs/system-map-1.md)。

## Web Search 重点验收

这是持续回归要求。状态：原生 Web Search provider + 受控宿主 HTTP 已通过浏览器验收；相同 Session 的远端 Bash 无法访问该 loopback 端点，且远端 env 中没有测试凭据。技能组合与外部真实服务已覆盖；双 Session 并发、连接器失败/取消仍待专项覆盖。

| 测试 | 必须观察到的行为 |
| --- | --- |
| 本地网络 API 与远端 Shell 网络命令 | 同一 Session 调用实际 Web Search 连接器和 Shell HTTP 探针，分别记录本地请求入口和目标 World 的执行证据；不能只凭工具名或正文判定地点 |
| 远端不能访问搜索服务，本地可访问 | 连接器仍可搜索，远端 Shell 请求按目标网络条件失败，不能改向本地；仅针对测试端点限制访问，不改变远端公共网络配置 |
| 两个 World 并发搜索与项目读写 | 搜索结果回到正确 Session，后续读写使用各自 World；同名 cwd 不串线，本地同名目录无副作用 |
| 凭据与项目数据边界 | 使用测试凭据，确认其不进入 helper 请求、远端 env/文件或公开产物；连接器只接收明确提供的查询/数据，不自动上传 workspace |
| 连接器超时、失败与取消 | 返回明确错误或取消结果，不重试到远端 Shell，不扩大为本地通用 shell 权限，不改变 binding；恢复后的远端操作仍指向原 World |
| 本地 skill 搜索后操作远端项目 | 通过明确本地连接器搜索、远端 provider 读写；本地脚本路径不赋予本地 shell 权，也不能作为隐式 transfer |

测试分受控宿主 HTTP 边界测试和安装态真实服务验收；两者不能互相替代。测试属于 integrations/dsh/tests/，结果按时间记录到 implemented notes。

## 远端 worktree（待处理）

状态：仅完成源码现状审计；用户要求本轮不实现。不是已有自动能力，不属于已完成的第一阶段。

期望：Git 仓库和新 worktree 都位于选定远端 World；新目录登记为该 World 下的新 portable_workspace，新 Session/Agent 在绑定持久化后启动。Git 工作目录与索引独立，仓库对象可共享；不能把相同 World 误当成相同 workspace。

当前可组合的部分：远端 subprocess 可以运行 Git；维护中 registry 的 createInWorld 只接收已存在的目录；startPortableWorkspaceSession 显式绑定后创建独立 Session。仓库中没有 worktree 创建器、模型工具、UI 流程或相关验收，不能称为自动支持。目标 Git、权限与仓库条件也未专项验证。

当前阻碍：worlds.ts 的 inherited/adopt 要求普通子 Agent 的 cwd 和完整绑定与父级相同，直接替换 cwd 或预绑定另一目录仍会冲突。固定 DSH 基线的 Web fork 复制源 cwd，不创建 Git worktree；workflow-worker-thread 的 isolation 属于 deferred options，现有测试明确拒绝 worktree 隔离。独立 Session 的源码入口可作为未来编排基础，但不等于已支持保留父子 lineage 的隔离子 Agent。

后续需要定界和验收：

- 执行位置：Git 命令、路径解析、目录存在性与仓库检查都在原 World；不得本地创建或失败回退。同一 World 的不同 workspace 必须有不同绑定。
- Git 状态：分支/目录冲突、分支已被其他 worktree 占用、并发重复请求、未提交和未跟踪内容的处理。默认不暗示新 worktree 会复制原工作目录修改。
- 创建失败：Git 已成功但 registry/Session 创建失败时如何重试、识别已有结果与清理；不能重复创建、重绑定旧 Session 或无条件删除可能已有修改的目录。
- Agent 关系：独立 Session 与隔离子 Agent 分开决策；如复制上下文，不能复制旧 cwd、执行绑定、终端和进程句柄。不得放宽现有继承检查来隐式改向。
- 仓库布局与权限：linked worktree 的 .git 是引用文件，Git common directory 和管理文件可能在 workspace 外。项目指令发现、远端路径解析、审批/policy 必须认识这一布局，不能简单把越出 cwd 都当成本地访问或都放行。
- 生命周期：重启后按持久绑定恢复；worktree 被移动、删除或 prune 时明确失败。Agent 结束不隐式删除 worktree，清理前处理修改、活跃进程和其他 Session 的引用。

历史源码审计基线：DSH d347e703908d0406b7a7ef80e3a0e594d86b2215，源码检查完成，未运行 Git/worktree 实验。

- 本仓库：integrations/dsh/experiments/portable_workspace/{registry,entry}.ts；integrations/dsh/plugins/ssh-world/src/{worlds,routing}.ts。
- 上游：packages/api/session-controller/src/commands.ts 的 fork；packages/subagent/subagent/src/child-agent.ts 的 cwd 继承；packages/workflow/workflow-worker-thread/src/runtime.ts 的 DEFERRED_AGENT_OPTIONS 及对应测试。
