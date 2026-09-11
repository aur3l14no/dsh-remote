# World-qualified DSH Web：后续工作

Status: proposed

## 当前基线

第一阶段已实现。用户、开发者和 CI 共用官方 DSH + 标准扩展 bundle，源码仅用于构建局部兼容包，不再提供源码宿主安装路径。当前架构与支持范围以 [系统全景](../../../../docs/system-map-1.md) 为准；版本与补丁列表以 [series.json](../../../../integrations/dsh/patches/series.json) 为准。

rc.1 适配、导航与预览重构、子 Agent catalog 提交失败清理已通过[独立复审和安装态验收](../../implemented/integration/2026-09-10-dsh-rc1-upgrade.md)。

World 配置重载、skill 变更预览与确认应用已通过[安装态与双 SSH 验收](../../implemented/integration/2026-09-11-worlds-reload.md)。

本页只维护后续事项和验收要求，proposed 不表示第一阶段未完成。已完成过程见 [原生 bundle 交付](../../implemented/integration/2026-09-08-native-bundle-delivery.md)、[DSH 新版适配](../../implemented/integration/2026-09-09-dsh-upgrade.md)；适配提交 4f3ad28 的 [GitHub CI](https://github.com/aur3l14no/dsh-remote/actions/runs/34304573317) 已通过。

Local + SSH workspace 共存已实现，见[本机与 SSH 验收](../../implemented/integration/2026-09-11-local-workspaces.md)。本机首先验收 macOS；其他原生平台与 E2B provider 仍需另行定界。

## 尚未完成的范围

| 项目 | 后续工作与边界 |
| --- | --- |
| 连接器鲁棒性 | 补双 Session 并发、超时/失败/取消专项验收；不改变本地连接器和远端 Shell 的分工 |
| 远端 worktree | 明确新目录、portable_workspace、新 Agent 关系与失败清理；见下文，未授权本阶段实现 |
| 附件后续 | 新附件远端持久源与按需宿主读取已实现，见[验收](../../implemented/integration/2026-09-10-remote-attachments.md)；旧引用迁移、存储 GC、跨 World 显式转移另行定界 |
| 远端 OS sandbox | 单独立项；目前父/子 Agent 使用 SSH 账户权限 |
| 发行完善 | 公共 npm/Release、helper 平台矩阵、ripgrep 与可信下载清单、安装 GC；现有 CI 产物不等于公开发布 |
| 其他消费者 | sameWorkspace Session 引用、LSP/Git 扩展、跨根 Agent 消息及外部 Agent 后端需单独适配 |
| 生命周期强化 | 子 Agent catalog 提交失败清理已覆盖；扫描中销毁、并发输出 release 等剩余专项验证继续保留，不得放宽绑定或取消语义 |

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
