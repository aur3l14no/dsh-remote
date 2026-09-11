# Local and SSH workspaces in the standard extension

Status: implemented. Baseline: DSH 0.1.5-rc.1, pinned upstream 183f08e9c6dde7e36cd2318eaee70b0da08fb35e. Existing workspace changes were committed as 22ecfc6 before this implementation, as requested.

## Decisions and implementation

- Common execution-world identity, bindings and routing are separated from SSH provisioning. Local borrows native FS/subprocess services and never constructs helper Client/info/epoch. The old SSH-module import paths re-export common interfaces for compatibility.
- A separate native WorkspaceRegistry domain owns durable local membership. The facade delegates local operations and merges local/SSH feed rows; local and SSH can use the same canonical path without sharing identity.
- This computer is built in. Optional worlds.json entry must use id local and target kind local. Native folder selection works without hand-written config; configured local paths merge with native recent workspaces and configured names update on Reload. Local remote-deployment fields reject.
- Standard composition derives from the pinned native preset. The original AgentPresets class retains standing-mount state; a subclass validates preset selection. SSH remains a separate remote composition. Native permission/sandbox behavior is retained for local; SSH defaults and historical missing permission facts use account permissions. Unsupported SSH preset changes reject before appending history.
- Patch 0010 adds optional admission preset selection, session-specific permission defaults/validation and native-registry bootstrapHistory control. It changes session-controller, permission-presets and workspace; series.json records hashes. Without the optional hooks, native behavior is retained. The extension contains 21 compatibility packages.
- v1 SSH binding bytes are backed up before the first local write upgrades storage to v2. Existing SSH identities remain unchanged. One-time native adoption requires verified durable membership and canonical original headers; child adoption requires proven parent lineage. Missing or ambiguous bindings never acquire local authority from cwd.
- Local instructions/skills, file references and attachments use native implementations. Local skills retain the filesystem provider identity/default roots/watchers. Remote skills use a distinct provider and remote-only preparation. Attachments retain native local digest IDs and paths, while SSH references retain World ownership.
- Browser folder selection captures the native directoryPicker dependency at composition time, matching the upstream service lifecycle. Selection cancellation and stale-navigation protection remain in place.
- A real SSH shutdown exposed late Duplex AbortErrors after the protocol iterator had ended. SSH transport now retains its error handler through close. A focused failure-handshake regression fails without this fix and passes with it; the client still receives protocol/transport failures.
- Builds externalize all foreign @deepseek-ai packages before esbuild tsconfig path resolution and reject foreign source in compatibility bundle metafiles. This prevents duplicated Cordis/scope state. Repeated same-version test installations use immutable archive paths.

## Acceptance on macOS

- Final installed local/mixed gate: passed, 2 tests, native macOS plus two real Linux SSH Worlds at the same absolute path. Concurrent files/Shell remain isolated; stopping one SSH container fails its operations while local and the other SSH World continue.
- Official vanilla host creates the local baseline; installing the extension preserves original native workspace/session IDs and existing log bytes. Native local read/write/Shell, workspace-write and read-only behavior, instructions, skills, file references, jobs cancellation, terminal ownership, child binding, fork and cold restoration pass.
- Chromium folder cancellation and actual new-folder selection pass. Browser image/file upload, model read/read_image, preview, child attachment read and ZIP export pass. The selected local Session displays Standard mode and Workspace Write.
- Local catalog rename and configured workspace name apply through Reload without remote skill operations. Cross-environment preset selection, unknown identity, explicit-id redirection and unsupported SSH permission changes reject; the latter leave history unchanged.
- Independent local-world dispatch gate observes zero bootstrap-provider, SSH connector and remote-skill preparation calls, with no helper service and borrowed native providers still available after owner disposal.
- Unchanged-source composition and package interface gates pass. Independent patched-host applies/typechecks/bundles successfully; real dual-SSH admission passes (retired catalog Worlds retain saved binding authority).
- Full installed dual-SSH browser lifecycle, attachment browser gate, official extension-install and connect-install pass. Full SSH lifecycle/attachment runs preceded the last local-picker and permission-selection guard changes; those final changes are exercised by the final mixed gate and final packaging gate.
- Final package tests: 4 passed, including add/repeat/remove/version rejection and fixed-name HTTP tarball install. Client/skill/binding focused tests pass. Runtime suite: 37 passed, 2 environment-gated skips; no runtime/helper source changes.
- Final archive SHA256: ced0e5dc0542584bdaaab6883e282bf00a30ed3f558a3df01b33b118901f934b.

Sanitized artifacts: artifacts/dsh/local-workspace-result.json, artifacts/dsh/mixed-workspace-result.json and artifacts/dsh/local-workspace.png. Private diagnostic logs and temporary account configuration remain under .build/dsh/ and are not release evidence. Docker stacks are removed by the runner.

## Boundaries

This acceptance proves native macOS local behavior and the existing Linux SSH matrix, not Windows or Linux native acceptance. E2B, remote OS sandbox, automatic worktree, general host-shell authority for skills, cross-World attachment transfer and GC remain out of scope. Native Open/Reveal path-only endpoints stay disabled in the mixed profile because they do not carry a World identity. Local configured paths are registered as native recent workspaces; removing a config entry does not delete those records. Cross-target Reload is not transactional; a native registration failure can leave already registered native entries, and must be repaired/re-previewed. Native adoption refuses ambiguous or noncanonical historical metadata; recovery instructions are in docs/reference/session-bindings.md. Custom user presets are not implicitly admitted into either execution domain.

## Approved scope (historical plan)

## Local 与 SSH workspace 共存（2026-09-11 重新定界）

Original plan status: proposed；用户明确要求重新规划。Local 是必须交付的一等能力。此次修订是方案，不代表已实现或部署。基线为当前工作区与 series.json 固定的 DSH 0.1.5-rc.1。

#
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


## Deployment

Deployed the SHA256-identified archive through the official CLI after a private pre-upgrade backup of Sessions, storage metadata and configuration. All 568 installed files match the archive. Launchd restarted the Web service; unauthenticated HTTP returns the expected 401. Private rollback files remain under DSH deploy/backups.
