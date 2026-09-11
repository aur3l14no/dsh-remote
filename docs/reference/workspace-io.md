# 文件预览与附件契约

功能与执行位置见[系统全景](../system-map-1.md)。本页保留路径、存储与兼容性的精确规则。

## 文件预览

文本、完整文档、关联资源、目录列表和文件变更通知均使用显式 Session 环境，不依赖 tools/execute 的 ALS。每次请求按持久 membership/binding 和逐级 Session header 校验选择 World；支持冷会话及子会话，不激活 Agent。workspace root 来自保存的绑定，调用者不能伪造 root 或根据 cwd 猜测 World。

普通文件采用 DSH rc.1 的读取语义：相对路径以 Session workspace 为基准，绝对路径和 `..` 可访问绑定 World 的 SSH 账户有权读取的项目外普通文件。文本分页、范围字节、完整文档和 HTML 关联资源始终使用同一 World FS，并保留类型、大小及最终 symlink 检查。目录列表和变更通知仍限制在 workspace 内；跨 World 或项目外 observation 不会进入该会话的文件流。

图片请求 `/api/file?path=...&sessionId=...` 使用同一身份解析。身份缺失、绑定冲突或 World 不可用时失败，不根据浏览器当前选中项、同名 cwd 或宿主文件决定路由。文件地址保持 Session 命名空间，包括项目外绝对路径；地址中的 `..` 不由浏览器规范化，以保留远端路径语义。`present` 交付文件使用原生侧栏预览；宿主 Open/Reveal 操作被禁用。此接口不提供任意 URL 代理或宿主文件兜底。

文件预览不提供 OS 文件 watcher；变更提示来自 Agent FS observation，外部编辑需手动刷新。旧 helper 缺少范围读取 capability 时提示更新，不用整文件下载模拟范围读取。

## 上传附件

local Session 委托原生 AttachmentStore，保留本机存储、裸摘要 ID、图片规则及历史引用；模型、预览、fork、子会话和导出均检查明确的 local binding。不会将带 SSH World 指纹的引用视为本机对象。

SSH Session 新上传的图片、原样文件以及 `read_image` 生成的图片对象，以远端为持久源。存储位于远端账户 `$HOME/.local/share/dsh-remote/attachments/v1/<World 指纹>/`，独立于项目目录、helper 安装和临时 runtime。指纹包含完整不可变绑定；不同 World 不因内容摘要相同而共享引用。Session 继续使用原生日志格式，附件 ID 携带内容摘要和 World 指纹。

上传、工具、模型转换、历史预览和 Session 日志导出通过 `attachments.forSession(sessionId)` 选择后端。写入先原子发布并完成 `fs.sync`，再返回可写入日志的引用；缺少该 capability 的旧 helper 明确拒绝附件写入。模型提示里的文件/图片读取路径属于远端账户，宿主缓存路径不会作为工具路径给模型。

宿主仍执行图片校验/归一化、模型请求编码，以及文件上传时的临时暂存。暂存文件在成功、失败和取消后删除；`$DSH_HOME/remote/attachment-cache/` 仅保存可重建的请求图片变体。请求图片即使有缓存，也先读取和校验远端源；断线、丢失、损坏或绑定冲突不能由宿主副本兜底。同一绑定的重启、冷预览和 fork 保留附件所有权。

原样文件上限由 helper 的 `uploadBytes` 决定，当前为 64 MiB；图片仍受 DSH 的数量、字节、像素和格式策略限制。内容寻址去重不等于存储 GC，未引用的已发布对象不会自动删除。工作区隔离不限制 SSH 账户本身修改附件的权限。

升级前已有的裸 `sha256:<摘要>` 引用明确归属旧宿主 attachment store，仍可用于模型读取和历史预览，不自动迁移，也不向远端工具宣称存在可读路径。旧附件需要工具处理时重新上传。自定义 profile 如直接配置被替换的附件、LLM、file-upload、subagent 或导出行，应改用 overlay 中对应的 `remote-*` 行 ID；Models 设置页与 `settings.yaml` 的 provider 配置键不变。
