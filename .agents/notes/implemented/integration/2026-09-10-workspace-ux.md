# 声明式工作区与紧凑会话侧栏

Status: implemented

## 决定与基线

按用户提供的 T3 Code / Codex 参考收拢 UX。基线为 DSH 0.1.5-rc.1，upstream revision `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`；本次为 `ea9177ca46693f5f57c5e9ab6f6daa63d33d0c9d` 上的工作区修改，未公开发行。

- `$DSH_HOME/remote/worlds.json` 声明 World、颜色、Workspace 和 Skills 选择；首次启动从旧 config.worlds 复制，控制状态与绑定存储分开。配置在宿主启动时读取。
- 侧栏移除连接、目录浏览和管理表单。通过原生 `conversation.hero.workspace` slot 提供按 World 分组的选择器，无新增上游补丁。
- 选择目录才连接、校验 canonical 路径并注册；等待工作区 feed 后交回原生会话导航。取消或后续导航使迟到响应失效；已有绑定不跟随选择改变。
- 三行卡片、单行截断、延迟详情提示。悬停或键盘聚焦直接显示置顶与归档图标；触摸设备显示操作。置顶保存于宿主 registry，归档取消置顶且保留历史。
- 原有维护 API 保留。展示设置变更通知工作区消费者，不依赖修改者在本地手工刷新颜色。

当前用法见 [World 配置](../../../../docs/worlds.md) 和 [Skills](../../../../docs/skills.md)。

## 验收

已通过：

- `check-web-plugin.mjs`：集成 host/client 类型。
- client + skill lifetime Node tests：10 项，含新会话清空选择、feed 等待、取消与迟到导航。
- packaging Node tests：4 项，含官方 CLI 安装/重复安装/移除与本地预览保留。
- `build-extension.mjs`：19 个兼容包与插件构建，未构建整套 DSH。
- `e2e.mjs -- ...connect-install.mjs`：官方 CLI 空白安装、worlds.json 声明、下载失败重试、离线缓存、同路径两 World；置顶/取消置顶顺序、宿主重启持久化、归档；长标题截断与 tooltip；延迟选择响应不覆盖后来打开的会话。
- `e2e.mjs -- ...extension-install.mjs`：原生 CLI 与 Playwright，无 scaffold；预连接 Skills 失败阻断/重试，自动/手动同步、选择持久化、未选中保留副本、同步不重启 helper。
- `e2e.mjs -- ...web-e2e.mjs`：两 Linux/SSH World 浏览器生命周期、预览、真实远端文件/进程、fork、冷恢复、child/terminal/jobs、取消、缺失 binding 与停止 World 拒绝。

本轮报告位于 `artifacts/dsh/connect-install.json`、`extension-install.json`、`result.json`；截图位于 `workspace-picker-open.png`、`sidebar-hover-actions.png`、`sidebar-hover-details.png`、`sidebar-cards.png`。这些是可重建输出，历史验收文件未修改。

## 范围

worlds.json 修改仍需重启宿主，不提供文件 watcher。卡片只展示已有事实，不增加连接状态或活动时间的推断。没有修改 runtime、binding 格式、执行权限或 upstream patch series；本轮未重跑未改的 unchanged-source gate，也不声明真实模型或新的附件专项验收。官方安装态回归及双 World 运行结果不等于已部署到用户正在使用的 profile。

## 后续清理（同日）

用户明确要求继续删除旧 UI 管理链路，取代上文保留维护 API 的决定：移除 hosts/connect/directories/configureWorld/syncSkills RPC、HostConnections 与配置写回、动态 World 注册回调、无调用者的 registerWorkspace 和 control.js 独立打包。只保留 worlds/create/pinSession RPC。自动 Skills 同步、独立部署命令、旧展示设置读取及绑定校验保留。

旧管理入口专属测试删除；安装态验收改用声明式颜色/Skills 选择和独立部署，覆盖未选择的无效来源不被同步。清理后通过 check-web-plugin、9 项 client/skill lifetime 测试、扩展构建、extension-install 和完整双 Linux/SSH World 浏览器回归。未为此重跑其他未改的 gates。

按 packages、packaging（不含文档）及 build-extension 脚本统计，整轮 UX 相对原 HEAD 增加 248 行、删除 399 行，净减少 151 行；相比清理前再净减少 181 行。测试与文档不计入产品代码统计。
