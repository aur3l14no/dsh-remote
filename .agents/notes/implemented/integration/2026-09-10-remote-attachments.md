# Remote-authoritative attachments

Status: implemented

## 决定与边界

新图片、文件和 `read_image` 产物以 Session 绑定远端为持久源；宿主按需读回供模型、预览和导出使用。远端对象目录独立于项目、安装 cache 和临时 runtime。附件 ID 使用内容摘要加完整 WorldDefinition 指纹；不修改原生 Session 日志格式。旧裸 sha256 引用继续明确读取旧宿主 store，不自动迁移；工具需要旧文件时重新上传。

DSH 专属策略放在 `workspace/remote-attachments` 插件。0007 只提供 Session 选择、执行路径和复用图片处理的宿主接口，并贯穿上传/模型/工具/预览/导出/子 Agent 消费者；runtime 只新增通用流式写入和 `fs.sync`。远端发布和 fsync 成功后才交出引用；取消移除宿主暂存，已发布但未引用的远端对象不自动 GC。原样文件当前最大 64 MiB。

装配必须 disable + insert：include 的 patch.name 是匹配断言，不能替换实现。浏览器验收曾捕获仍在使用本地 store 的错误配置，修复后要求真实上传返回 World 命名空间。`read_image` 的嵌套注入补上 fs，保留原生图像能力检查。

## 基线与验收

DSH 0.1.5-alpha.1，源码 `5dda764ed3aa172535a7967b06ff95d9cbfe536a`；补丁 0007 SHA-256 `6f402c8d68abd15ea314e8fcb0b8946a18a1c9166709e9a590a1858c6f104f80`。本地构建扩展候选 0.3.1，17 个兼容包。未发布；GitHub runner 尚未运行本次修改。

- Cargo fmt/clippy/build 通过；npm 类型检查通过；runtime/client/bootstrap/bindings/skills 共 34 项通过，2 项环境条件用例跳过。新用例检查完整流发布、长度不匹配、源异常、取消清理、fs.sync 和拒绝 symlink/非普通文件。
- unchanged-source composition、package/declarations、跨独立进程的包行为 gate 通过；patched-host Session 准入及原生 local create/resume 通过；附件专项和 Web plugin 类型检查通过。
- 原生与 Docker 双 Linux/SSH World 附件专项通过：同内容跨 World 隔离、去重、文件字节、真实 pi-ai 请求编码到受控 HTTP 端点、远端模型路径、read_image、取消、重启/冷预览/fork、旧引用，以及远端丢失或损坏时禁止宿主缓存兜底。
- 官方 CLI 安装/重复安装/版本拒绝/卸载等 packaging 测试 3 项通过。
- 安装态 Chromium 附件测试通过：真实文件选择和上传传输、文件与图片工具、远端路径、预览、fork、关闭后冷预览和 UI 重开。模型响应使用显式声明图片能力的 MockAdapter；没有调用付费模型或验证真实模型视觉理解。
- 既有完整 `portable-workspace.e2e.ts` 回归通过，覆盖双 World、instructions/skills、search、子 Agent、终端、重启和失败路径。

浏览器脱敏结果：`artifacts/dsh/attachments-result.json`、`artifacts/dsh/result.json`；截图 `artifacts/dsh/attachments-uploaded.png` 和 `artifacts/dsh/attachments-restarted.png`。CI 已添加附件源码/SSH/浏览器 gate 和报告白名单，真实 runner 结果待推送后确认。

当前契约见 [执行边界](../../../../docs/execution-boundaries.md#上传附件)，命令见 [开发](../../../../docs/development.md)。旧附件迁移、存储 GC、全量远端 sandbox 与跨 World 转移不属于本次实现。
