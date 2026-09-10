# 文件预览与附件契约

功能与执行位置见[系统全景](../system-map-1.md)。本页保留路径、存储与兼容性的精确规则。

## 文件预览

文本预览、目录列表和文件变更通知使用显式 Agent environment，不依赖 tools/execute 的 ALS。workspace root 来自该 Session 的 portable_workspace，不使用账户权限策略中的 `/`。路径先在远端解析；最终条目为 symlink 或解析后越根时拒绝；workspace 仍不限制 Shell 的 SSH 账户权限。

图片请求 `/api/file?path=...&sessionId=...` 按持久 Session membership/binding 准备 World，支持冷会话。身份缺失、绑定冲突或 World 不可用时失败，不根据浏览器当前选中项、同名 cwd 或宿主文件决定路由。图片保持官方绝对路径语义：可以读取 workspace 外但 SSH 账户有权读取的普通文件，受图片字节上限约束。它不提供任意 URL 代理或本地文件能力。

文件预览不提供 OS 文件 watcher；变更提示来自 Agent FS observation，外部编辑需手动刷新。旧 helper 缺少范围读取 capability 时提示更新，不用整文件下载模拟范围读取。

## 上传附件

新上传的图片、原样文件以及 `read_image` 生成的图片对象，以远端为持久源。存储位于远端账户 `$HOME/.local/share/dsh-remote/attachments/v1/<World 指纹>/`，独立于项目目录、helper 安装和临时 runtime。指纹包含完整不可变绑定；不同 World 不因内容摘要相同而共享引用。Session 继续使用原生日志格式，附件 ID 携带内容摘要和 World 指纹。

上传、工具、模型转换、历史预览和 Session 日志导出通过 `attachments.forSession(sessionId)` 选择后端。写入先原子发布并完成 `fs.sync`，再返回可写入日志的引用；缺少该 capability 的旧 helper 明确拒绝附件写入。模型提示里的文件/图片读取路径属于远端账户，宿主缓存路径不会作为工具路径给模型。

宿主仍执行图片校验/归一化、模型请求编码，以及文件上传时的临时暂存。暂存文件在成功、失败和取消后删除；`$DSH_HOME/remote/attachment-cache/` 仅保存可重建的请求图片变体。请求图片即使有缓存，也先读取和校验远端源；断线、丢失、损坏或绑定冲突不能由宿主副本兜底。同一绑定的重启、冷预览和 fork 保留附件所有权。

原样文件上限由 helper 的 `uploadBytes` 决定，当前为 64 MiB；图片仍受 DSH 的数量、字节、像素和格式策略限制。内容寻址去重不等于存储 GC，未引用的已发布对象不会自动删除。工作区隔离不限制 SSH 账户本身修改附件的权限。

升级前已有的裸 `sha256:<摘要>` 引用明确归属旧宿主 attachment store，仍可用于模型读取和历史预览，不自动迁移，也不向远端工具宣称存在可读路径。旧附件需要工具处理时重新上传。自定义 profile 如直接配置被替换的附件、LLM、file-upload、subagent 或导出行，应改用 overlay 中对应的 `remote-*` 行 ID；Models 设置页与 `settings.yaml` 的 provider 配置键不变。
