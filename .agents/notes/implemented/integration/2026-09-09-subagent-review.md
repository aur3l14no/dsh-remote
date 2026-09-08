# Subagent review 与 CI 跟进

Status: implemented

## 范围与发现

用户要求对已推送迁移做 subagent review 并跟进 CI。子代理没有文件工具，主代理提供 config/setup、skills sync、control 的完整源码以及相关官方解析代码；子代理做有界静态复核，主代理负责核对和复现。这不是独立全仓审计。

两个确认的 P2 已修复：

1. config 初始化器没有使用官方 DSH_HOME 解析：空值会写到 cwd，字面 ~/ 路径不展开。改用官方 resolveDshHome，并为初始化命令显式声明该包依赖，避免依赖启动后才创建的 profile fallback。仓库外原生 CLI/Playwright 安装测试现在始终使用字面 ~/ 路径；安装与移除门禁通过。
2. 控制进程 close 过早取消 SIGKILL：孙进程忽略 SIGTERM 且关闭 stdio 时仍会存活。POSIX stop 后保留500ms进程组升级，并在强制清理后结算。新增 heartbeat 测试在原实现失败，在修复后通过；记录PID并在finally清理测试进程。

同步队列复核未发现确定P1/P2；官方版本检查的“扩展私有DSH副本”疑点不成立于当前安装拓扑，因为扩展不依赖另一个DSH宿主。额外安装的第三方插件拓扑仍不在本次证据内。

## 验收

- 通用测试32通过、2环境选择skip；类型检查通过。
- native plugin add/config init/Playwright + 双World通过，涵盖字面~/路径。
- 重复安装、错误版本拒绝、移除恢复及官方文件摘要不变通过。
- helper prebuild已在GitHub通过；主CI后续状态以当前提交对应的Actions run为准。最终CI结果在用户回复中报告，不把本地通过当作CI通过。
