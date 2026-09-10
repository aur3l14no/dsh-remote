# DSH 0.1.5-rc.1 适配与重构

Status: implemented

## 决定与基线

从 DSH `0.1.5-alpha.1` / `5dda764ed3aa172535a7967b06ff95d9cbfe536a` 升级到 `0.1.5-rc.1` / `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。当前 [series.json](../../../../integrations/dsh/patches/series.json) 记录 9 个补丁、19 个兼容包。官方 npm 安装、独立 patched-host 与 unchanged-source gates 分离；没有重新构建完整 DSH 宿主或前端。

按用户指定采用上游普通文件读取语义：文件可以在 workspace 外，但始终由 Session 保存的 World FS 执行。目录列表和变更流仍限 workspace；没有宿主兜底、cwd 猜测或浏览器路径规范化。文本、字节范围、整文件、HTML 关联资源和媒体共享同一身份解析，支持冷会话和子会话，逐级校验持久 header / cwd / binding，不激活 Agent。

原生文件地址已保留 Session，因此移除自建的 Chat 文件地址和预检查逻辑。0006 仅提供显式文件/媒体环境及所需 Session 传递。本地无环境 provider 分支通过合法 Cordis 服务查询读取本地 FS；远端 provider 失败不进入该分支。

导航从 React 入口拆出，实现 rc.1 的 openSession/openWorkspace/forkSession 与 layout 生命周期。blank Session 只在对应 portable workspace 内复用；注册目录、创建和 fork 的异步完成不得覆盖更新的面板选择或已销毁的导航。

新增 0008 修复上游 Sidebar 的字面 URI namespace glob 无法匹配 `.` / `..` 的问题，原始 Session 和路径继续传给 canOpen/contentId，不解析远端 symlink。新增 0009 使禁用 native desktop 的 profile 仍可激活原生 present 元数据和拒绝入口；Open/Reveal 在接触宿主 FS 前返回 409。remote preset 增加原生 present 工具，文件卡片使用原生文档预览。

## 验收

macOS 宿主，官方 npm DSH 与安装后的扩展 tarball；真实双 Docker Linux/SSH World，路径均为 `/workspace`。扩展候选仍为本地开发版本 0.3.1，未发布。GitHub runner 尚未执行本次修改。

- npm 类型检查通过；runtime/client/bootstrap/bindings/skills 34 项通过、2 项环境条件用例跳过。该跳过不替代下述实际 SSH 验收。
- unchanged-source composition、package/declarations、跨独立进程行为通过；预期的原生 Web admission 缺口仍由该 gate 明确报告。patched-host 类型检查、准入与 Linux/SSH 行为通过。
- Web 插件、Chat 与 Sidebar 浏览器类型检查通过；19 个兼容包构建及官方 CLI 安装通过。验证依赖按上游版本固定，不放宽诊断。
- packaging 4 项、客户端 6 项、release 4 项通过。新增真实本地插件回归覆盖 WorkspaceFiles 和 /api/file；恢复旧 ctx.fs 的隔离负控准确失败。Sidebar 另有上游真实 registry 36 项通过，旧 matcher 在新增用例中失败。
- 完整安装态浏览器通过：双 World 隔离、项目指令/Skills、受控宿主搜索、前后台 Bash、终端、fork、归档、V2→V3 原地迁移、冷恢复、取消、缺失绑定与 World 不可用时明确拒绝。
- 预览覆盖宿主/双 World 同路径隔离，范围/完整/关联读取，允许项目外普通文件、拒绝最终 symlink 和项目外目录、跨 World/项目外 observation 过滤。原生 present 卡片实际打开文本、HTML/CSS、PDF 和 SVG；检查 CSS 计算样式、PDF canvas 红色像素、图片尺寸及 native open/reveal 409。
- 原生子 Agent 验收覆盖一次性和可续接 Agent 的 catalog 注册、重启与 fork catalog、catalog append 失败时未发布实例的清理以及后续恢复。没有通过删除 binding 来放宽或伪造准入。
- Linux/SSH 附件宿主专项与安装态浏览器附件验收通过：远端持久源、模型请求编码、上传/下载/预览、fork、冷恢复、取消、旧引用及失效远端不得用宿主缓存兜底。
- Skills 部署、native CLI extension-install、Connect 自动 runtime 下载及离线重启通过；测试适配 rc.1 重启后的 Configure later 流程。

浏览器模型输出使用 synthetic replay / MockAdapter，工具、SSH、文件、传输和浏览器渲染实际执行。本轮未调用付费真实模型或远程生产服务；未新增 OS sandbox、worktree、旧附件迁移、GC 或跨 World 转移能力。

## 独立复审与证据

独立子代理复审发现并确认修复了本地 FS 注入和注册阶段 stale navigation 两项问题；复核 0008/0009、模块身份、World 权限和最终测试/CI 变更后，无剩余必修问题。完整浏览器最后于 2026-09-10T07:56:02.780Z 通过，所有测试容器正常清理。

原始脱敏结果保留原字节：

- [完整浏览器](evidence/2026-09-10-rc1/result.json)
- [附件浏览器](evidence/2026-09-10-rc1/attachments-result.json)
- [原生 CLI 安装](evidence/2026-09-10-rc1/extension-install.json)
- [Connect 与离线重启](evidence/2026-09-10-rc1/connect-install.json)

当前接口见[文件预览与附件契约](../../../../docs/reference/workspace-io.md)，复现入口见[开发指南](../../../../docs/development.md)。历史 alpha.1 与附件验收记录保持原样。
