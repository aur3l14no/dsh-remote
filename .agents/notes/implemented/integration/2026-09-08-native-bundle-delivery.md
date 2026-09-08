# 原生 DSH bundle 交付迁移

Status: implemented

## 问题与决定

用户要求官方 DSH + 扩展/overlay，开发者与用户同一安装方案。曾验证自定义启动器与 Node hook，但用户指出应遵循生态的 `dsh plugin add`。官方 publish 文档明确支持 npm 预构建包和 tarball，不要求用户携带我们维护的安装 lockfile。

最终使用标准 dsh.bundle。官方版本由 series.json 固定为 0.1.3-alpha.2 / 82a5fd61；旧 alpha.1 源码没有对应 npm 版本。五个补丁原样适用，共七个包。构建只导出固定源码并编译这些包及外部插件，复制官方 client/Typert 产物。overlay 禁用原生 session/workspace controller 和 skill registry，再插入包内兼容实现；四个工具/instructions 在 remote preset 作用域内加载。

相对 insert 由官方 loadOverlayPatches 锚定 bundle 所在目录。client-modules 和 inventory 从模块文件找最近 package.json，保留原生身份。兼容包之间的普通 imports 构建期指向包内相对文件；不能合并 shared chunk 改变 import.meta.url。上游反向运行时引用只涉及 skill 的纯函数/常量：session-controller/tool-skill 已重定向，skill-filesystem/skill-badge 在所选 composition 禁用。用户新增其他插件仍应单独检查。

配置初始化命令只创建私有 config/bindings，已有目录拒绝覆盖。普通启动只打开已有绑定，不重新创建丢失映射。setup 检查官方版本后发布 remoteSetup，兼容服务与 preset 配置依赖该门禁。

替代方案：保留 hook 启动器和锁定分发包已放弃；整套源码宿主构建已移除。CI lockfile 只维护官方构建/测试输入，用户安装协议仍是原生 plugin add。

## 本地验收

- 原生 CLI 安装、初始化、Web 启动及 Playwright 双 World：自动/manual skills、失败重试、不重启 helper；最终 tarball 真实 DeepSeek 远端脚本执行、独立 SSH 重跑和另一 World 隔离通过。
- 无 hook 完整 browser/SSH 回归通过：创建、membership、fork、冷恢复、远端 AGENTS/skills、子 Agent continuation、工具过滤、终端、后台 jobs 与取消、binding 丢失、停止 World、Web Search 宿主边界。
- 独立 profile 原生 add、重复 add、错误版本拒绝、remove 恢复通过；七个官方文件摘要前后一致。用户 home/profile 移至仓库外临时目录的最终 tarball 安装检查也通过，不借用仓库 node_modules。
- npm check、Web host/client 类型检查通过；npm test 31 passed / 2 环境选择 skip。受限 shell 下 helper 启动失败，允许本地测试 socket 后重跑通过。
- subagent 基于具体实现与上述证据复核，无明确阻断项；无文件工具，不能视为逐行/全仓审计。

原始本地报告在忽略的 target/web-acceptance 与 target/native-*.log；不上传私有日志。CI 安装与上传的是同一 extension tarball。尚未 push/运行 GitHub CI，未发布 npm 或公开 Release。worktree、附件桥接、远端 OS sandbox 不在本次迁移范围。
