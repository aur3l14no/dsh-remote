# 子 Agent、终端与源码交付验收

Status: implemented

## 决定与实现

用户确认第一版使用所选 SSH 账户权限，OS sandbox 单独做；固定 DSH revision 源码安装与启动先交付，独立 npm Web 包延期。沿用 5 个补丁、7 个原生包，没有增加 Agent loop/Session schema 补丁。

子 Agent 沿持久 parent lineage 查找 portable_workspace，逐级验证完整 binding 与 cwd；不把 child 放入顶层列表。原生 continuation 保留 child Session、工具过滤与完成通知。terminal plugin 将原生 BashTerminalBackend 接到 Agent 的远端 subprocess，保留原生 owner/disposal。account-policy 仅允许 danger-full-access；它不替换独立 ApprovalService。

源码构建的 --production 排除测试 scaffold。start-web init 只接受新私有目录；start 验证持久 bindings 和构建 revision，直接启动原生 DSH CLI。保留原生欢迎页、模型配置及逐次审批流程，不读取个人配置。最小 DeepSeek 配置由用户授权从 ~/.dsh 提炼到忽略的 .local/deepseek-only。

## 本地验收

- 根 TypeScript 与 Web plugin 类型检查通过；npm test 29 passed、2 skipped（显式环境启用的原生 bootstrap/SSH 用例）。修复三处回归测试中不符合 OutputSpec 的 stderr 字符串，未改变 runtime API。
- patched-host 源码 gate 及真实双 Linux/SSH World admission 回归通过。
- 扩展 keyless Web/Chromium：普通与冷恢复各 17 个 tool results；child 单独 replay；远端 AGENTS/skill/script、终端读写/隔离/关闭、原有 fork/管理/取消/缺失 binding/停止 World 通过。
- child continuation 在两个完整宿主生命周期执行同一部署 skill；保留同一 child ID；原生 allowlist 隐藏并拒绝 terminal_open；跨父级发送及损坏 binding 拒绝且不执行模型；不支持的 sandbox mode 不污染即时与冷恢复状态。
- 真实 DeepSeek v4-flash + 外部 Web Search：编写并运行 sum.sh/test-sum.sh、执行部署 skill、实际 search result 成功且含 docs.python.org，独立重跑测试通过，远端 key 未设置，另一 World 无文件变化。
- 生产构建原生 CLI + Playwright：无 scaffold、首次欢迎流程、新私有 profile、远端 Session 创建通过；无密钥路径与真实模型路径分别验收。真实模型写入并执行 cli-proof.sh，独立远端重跑、另一 World 无输出、远端凭据不下发通过。

本机是 Mac/OrbStack + 两个无宿主文件挂载的 Linux SSH 容器。外部 API 只接收合成任务数据；没有将个人项目发往模型。第一次自动审批拒绝后，核实无挂载及官方端点，以明确的合成数据范围重新提交并获准；不是绕过拒绝。

## 重要 workaround 与限制

日常 CLI 使用 --expose-internals 走固定上游已有 Loader 解析路径；当前验收 Node 24.19。preset 在 profile 锚点解析，安装显式链接插件依赖，确保不在 CLI 默认集合中的 terminal 等工具可用。禁用依赖本地 confinement/shell 的 permission 预设与选择器；独立 approval 服务、answerer 和 UI 保留，未设置 DSH_PERMISSION_MODE 时默认 ask。

源码位置与依赖布局不能任意移动；未提供跨 revision 自动迁移。完整 OS sandbox、自动 worktree、附件传输、独立终端面板、独立 npm 发行仍延期。Web Search 故障/取消与双 Session 并发、扫描中销毁等专项覆盖尚不完整；本机成功不等于 GitHub runner 已通过。CI 新增生产构建与 keyless CLI gate，但未在本轮声称远端运行成功。

## Review

用户要求的 subagent 终审已执行。reviewer 无独立文件/命令工具，基于提供的代码、原生接口语义和主 agent 的测试结果审查；没有剩余确定性 P1/P2。其建议补上生产构建断言、真实远端工具执行、审批语义核对和依赖版本冲突拒绝均已处理。不是独立全仓审计。

源码启动方案已被[原生 bundle](2026-09-08-native-bundle-delivery.md)替代；当前使用方式见 [README](../../../../README.md)。

脱敏原始结果：[Web/child](evidence/2026-09-08-child-terminal-web.json)、[真实模型/搜索](evidence/2026-09-08-live-model-search.json)、[源码安装](evidence/2026-09-08-source-install.json)、[原生 CLI 真实执行](evidence/2026-09-08-source-install-live.json)。仅复制通过结果，未复制日志或私有状态。
