# 重要假设与 workaround（验收用一页）

Status: proposed

本页是待用户验收的持续决策表；具体实现与测试结果见[验收记录](../../implemented/integration/2026-09-08-child-terminal-source-acceptance.md)。原生插件交付见[迁移验收](../../implemented/integration/2026-09-08-native-bundle-delivery.md)；延期范围及专项未覆盖项仍按下表保留。

| 项目 | 当前决定 / 假设 | 验收与限制 |
| --- | --- | --- |
| AGENTS 发现 | 指远端 AGENTS.md/CLAUDE.md、local overlay 和嵌套指令；World × canonical cwd 是权威 | 两 World 同路径不同指令、嵌套与冷恢复已验收；全局目录用远端 `$HOME/.dsh`，不自动合并宿主个人 AGENTS |
| Skill 部署 | 显式配置选择本地已管理的完整 skill 文件夹，复制到远端 `$HOME/.local/share/dsh-remote/skills/<name>/<digest>`，链接进 `$HOME/.agents/skills` | 保留文件权限和空目录；源根可为 APM 链接，内部 symlink/特殊文件拒绝；同名非托管条目拒绝覆盖 |
| Skill sync (2026-09-08) | Host orchestration syncs configured sources before each new helper; Sync Skills updates an existing connection without restart | No watcher or sync on same-runtime transport recovery; remote home is shared by SSH account. Existing revision permission drift fails explicitly; dependencies remain separately managed. |
| 管理与 exec | APM/chezmoi/skill-ops 管理来源及依赖适配；本项目部署内容，Shell 在绑定 World，连接器留宿主 | `requires` 只检查命令存在，不证明版本兼容；不安装 runtime、不自动复制凭据、不改写 shell、不增加通用 host-shell 权限 |
| 部署原子性 | Linux + POSIX shell/tar/diff/GNU coreutils；按 skill 原子切换链接 | 整个列表不是事务；省略不卸载，旧 revision 保留。SIGKILL 可能留锁/暂存目录；无自动 GC |
| 发现接口补丁 | lookup 携带 Session 身份；instruction 非工具阶段显式 Agent environment；5 个补丁涉及 7 个原生包 | 沿用原生解析、调用控制和 instruction 生命周期；冷 catalog 准备绑定但不发布 Agent |
| 更新与取消 | 无远端 watcher，关闭 catalog 缓存；每次重新发现；调用者独立取消等待，插件销毁取消扫描 | 不承诺实时更新已注入上下文；共享查询取消已有单元测试，扫描中销毁尚无独立 integration 回归 |
| 文件补全与 jobs | 文件补全显式远端扫描；背景任务沿用原生 jobs，回调持有具体进程句柄 | 每查询最多扫描 50,000 项、返回 20 个候选；越 canonical root 路径不显示。双 World 隔离与取消已验收 |
| 输出预算 | Bash 每流预留 4 MiB；helper 0.1.2 在 release 时归还未用预留，完成 spill 文件仍计费 | 活跃预留与保留文件合计上限 64 MiB；不是无限历史输出。回归覆盖复用和持久文件配额；并发 release 尚无专项回归 |
| 测试 workaround | 上游 Vitest/Playwright scaffold 只复制测试；解析到官方已安装 JS，注入持久状态与禁用目录选择选项 | 产品无解析 hook；完整回归使用原生 bundle overlay。CLI gate 实际 plugin add 同一 tarball，不用 scaffold；本地结果不替代 GitHub runner |
| 账户权限（用户已确认） | 父/子 Agent 使用选定 SSH 账户权限；OS sandbox 延期，非法 mode 拒绝；当前 remote overlay 禁用原生 permission/UI | World/cwd 是路由身份，不是 containment；工具名 allow/deny 不等于 OS 隔离，不承诺逐次审批界面 |
| 子 Agent / 终端 | 原生生命周期与工具过滤；child 沿持久 lineage 找到顶层 workspace；终端创建显式选择 provider | 不让子 Agent成为顶层成员；one-shot、continuation 重启与终端隔离已验收，工具过滤、跨父级发送与损坏 binding 负例也已通过 |
| 原生发行（替代源码启动） | 官方 npm 0.1.3-alpha.2 + 标准 dsh.bundle；plugin add 安装，官方 CLI 启动；CI 只编译 7 包和我们的插件 | alpha.1 没有对应已发布版本；alpha.2 的 5 个补丁原样适用。相对 insert 保留 client/Typert 身份；包内 import 构建期重定向，不改官方文件、不用 Node hook |
| 依赖版本 | CI lockfile 固定构建/测试输入；用户遵循原生 pnpm 解析，门禁检查 DSH 与七个相关官方包版本 | 不声称用户整棵传递依赖图与 CI 完全相同；升级需要重跑安装与 browser gates，不另造用户 lockfile 协议 |
| 真实服务与延期 | DeepSeek-only 凭据留宿主；最终原生 tarball 已通过真实模型远端执行，另有 Web Search 边界回归 | npm/公开 Release 尚未发布，CI 尚未推送运行；helper prebuild 仍需 GitHub 平台验收。附件桥接、worktree、远端 OS sandbox 延期 |

终审：subagent 基于提供的最终代码片段/摘要完成静态 review，未独立读全仓或运行测试。空目录、HOME 取消、销毁后创建 provider 的问题已修复；未发现剩余确定性 P1/P2。此结论不等于独立完整审计。


新版适配中的重要假设（2026-09-09）：新 helper 通过 fs.read-range 显式协商范围读取，旧 helper 拒绝该能力；文件预览按 Session/World 路由，不引入宿主 FS fallback。目录树范围与 SSH 账户权限分开：预览限定 portable_workspace 根，不改变 Shell 账户权限。Session V3 验收仅使用副本，保留旧日志与 bindings；真实用户会话不自动迁移。以上除范围读取外仍在实现，不能视为已交付。
