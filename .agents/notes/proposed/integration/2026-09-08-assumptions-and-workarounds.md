# 重要假设与 workaround（验收用一页）

Status: proposed

本页是待用户验收的持续决策表；具体实现与测试结果见[验收记录](../../implemented/integration/2026-09-08-skills-consumers-acceptance.md)。整体阶段仍未全部完成。

| 项目 | 当前决定 / 假设 | 验收与限制 |
| --- | --- | --- |
| AGENTS 发现 | 指远端 AGENTS.md/CLAUDE.md、local overlay 和嵌套指令；World × canonical cwd 是权威 | 两 World 同路径不同指令、嵌套与冷恢复已验收；全局目录用远端 `$HOME/.dsh`，不自动合并宿主个人 AGENTS |
| Skill 部署 | 显式配置选择本地已管理的完整 skill 文件夹，复制到远端 `$HOME/.local/share/dsh-remote/skills/<name>/<digest>`，链接进 `$HOME/.agents/skills` | 保留文件权限和空目录；源根可为 APM 链接，内部 symlink/特殊文件拒绝；同名非托管条目拒绝覆盖 |
| 管理与 exec | APM/chezmoi/skill-ops 管理来源及依赖适配；本项目部署内容，Shell 在绑定 World，连接器留宿主 | `requires` 只检查命令存在，不证明版本兼容；不安装 runtime、不自动复制凭据、不改写 shell、不增加通用 host-shell 权限 |
| 部署原子性 | Linux + POSIX shell/tar/diff/GNU coreutils；按 skill 原子切换链接 | 整个列表不是事务；省略不卸载，旧 revision 保留。SIGKILL 可能留锁/暂存目录；无自动 GC |
| 发现接口补丁 | lookup 携带 Session 身份；instruction 非工具阶段显式 Agent environment；5 个补丁涉及 7 个原生包 | 沿用原生解析、调用控制和 instruction 生命周期；冷 catalog 准备绑定但不发布 Agent |
| 更新与取消 | 无远端 watcher，关闭 catalog 缓存；每次重新发现；调用者独立取消等待，插件销毁取消扫描 | 不承诺实时更新已注入上下文；共享查询取消已有单元测试，扫描中销毁尚无独立 integration 回归 |
| 文件补全与 jobs | 文件补全显式远端扫描；背景任务沿用原生 jobs，回调持有具体进程句柄 | 每查询最多扫描 50,000 项、返回 20 个候选；越 canonical root 路径不显示。双 World 隔离与取消已验收 |
| 输出预算 | Bash 每流预留 4 MiB；helper 0.1.2 在 release 时归还未用预留，完成 spill 文件仍计费 | 活跃预留与保留文件合计上限 64 MiB；不是无限历史输出。回归覆盖复用和持久文件配额；并发 release 尚无专项回归 |
| 测试 workaround | 复用上游 Vitest/Playwright；scaffold 注入持久状态，alias 统一 scope 身份，导出 checkout 限制 Git 向上发现 | 不计入产品补丁。模型 replay + 实际 search provider/受控宿主 HTTP，不能替代真实模型、真实外部服务或 GitHub runner 证据 |
| 暂停边界 | 子 Agent 权限继承/lineage 准入未完整适配；terminal UI、附件桥接、公开 Web 发行未完成；worktree 按先前要求延期 | 按用户条件停止高不确定性推进；不把“远端 SSH 账户权限”描述成 workspace sandbox。真实服务配置尚未提供 |

终审：subagent 基于提供的最终代码片段/摘要完成静态 review，未独立读全仓或运行测试。空目录、HOME 取消、销毁后创建 provider 的问题已修复；未发现剩余确定性 P1/P2。此结论不等于独立完整审计。
