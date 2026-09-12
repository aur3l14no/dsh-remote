# 上游升级参考

功能与上游概念的对应关系、整体装配见[系统全景](../system-map.md)。本页只维护逐项升级风险、补丁移除条件与操作顺序。标准 bundle 安装不代表任意上游版本兼容。

版本、源码 revision、补丁摘要和修改包的唯一权威是 [series.json](../../integrations/dsh/patches/series.json)。启动检查版本；升级必须成对验证官方 DSH 和扩展，不能仅放宽版本号。

## 易失效的接口

| 依赖 | 为什么容易断；必须保留的行为 | 对应检查 |
| --- | --- | --- |
| Cordis 服务身份与隔离域 | 相同类名不等于相同服务实例。兼容包相互 import 必须指向同一份包内实现；FS/subprocess/router 和消费者必须在同一 preset 域。不能用 Node resolve hook 修补身份冲突 | composition、packaging、安装态测试 |
| 插件激活顺序 | feed 必须独立激活后，registry 才能释放 controller；Remote namespace 也要先于消费者可用。在尚未激活的父插件里提供服务，可能造成启动等待或缺失服务 | patched-host、官方 CLI 冷启动 |
| Session 创建 / 恢复 / fork / child continuation | 上游调度、事件顺序或 lineage 字段变化，可能使 Agent 在绑定持久化前发布。恢复以保存的 binding 为准；普通 child 逐级核对父绑定，显式 child 复查保存的 parent 授权与目标 Workspace；缺失身份拒绝，不能根据 cwd 猜 World | admission、子 Agent、重启恢复和丢失 binding 负例 |
| 工具之外的文件访问 | 替换 ctx.fs 不会拦截 node:fs。instructions、skill lookup、图片/目录预览和文件引用发生在不同生命周期；它们也必须拿到明确的 Session/Agent 身份。上游新增一个宿主 realpath/readFile 就可能绕过远端 | 同路径宿主 / 双 World 的指令、skill、预览测试 |
| 浏览器模块与协议身份 | 最近的 package.json、dsh.client 注入、client factory、ModuleLoader ID 和 Typert namespace 共同决定加载与通信。单独编译通过不代表浏览器识别的是同一个模块；图片 URL 必须携带渲染所属 Session | preview-client 类型检查、安装态 Playwright、图片与 deep link |
| 原生 Session 日志格式 | 上游 Session 存储在宿主，日志格式变化需验证恢复与绑定 | 当前格式冷恢复、fork、child 与 binding 保持测试 |
| subprocess / terminal / jobs 契约 | 输出预算、同步读取、取消、owner、关闭顺序改变时，helper 协议不一定报类型错误，但可能泄漏进程或串用旧句柄。新 runtime 不恢复旧句柄、不重放命令 | 真实 SSH、后台 jobs、终端隔离与取消 |

启动版本检查是提前拒绝不支持的组合，不是完整语义验证；这些接口不少属于上游实现细节。

## 哪些补丁可以怎样收敛

保留 DSH 原生 Agent/Session 和工具逻辑，只补可选接口。下表是移除条件，不是上游已经提供的能力；上游接纳后应逐个删除补丁和对应兼容包，再跑原生与安装态验证。

| 补丁 | 最小上游能力；可移除条件 |
| --- | --- |
| 0001 session-admission | create/adopt/resume/fork 发布前可等待异步准入，并能传播失败 |
| 0002 workspace-feed | 原生 workspace controller 接受外部 registry/feed，继续复用原生 Remote、store 和操作命令 |
| 0003 bash-workdir | Bash 的 cwd 通过显式 Agent 所属 FS resolver 解析，失败不走宿主路径 |
| 0004 fs-cwd | 文件工具在处理 parent traversal 前，通过注入 FS 解析 cwd |
| 0005 context-environment | instructions、skill 查询和缓存携带 Agent/Session 环境；图片读取允许显式 resolver |
| 0006 file-preview-environment | workspace files 与媒体使用 Session 所属 FS/root；原生地址已携带 Session，无需另造文件地址协议 |
| 0007 session-attachments | 附件消费者传递 Session，后端可提供执行环境路径和复用图片校验/归一化；模型上传索引接受不透明附件 ID |
| 0008 sidebar-resource-dot-segments | 原生侧栏 URI glob 能识别包含 `.` / `..` 的地址，且保留 Session 与路径原文 |
| 0009 present-desktop-availability | 禁用宿主打开时，交付文件 HTTP 元数据与拒绝入口不再依赖宿主 FS / sandboxPolicy |
| 0010 local-workspace-admission | 准入可选择 Session preset；原生 registry 可关闭按 cwd 自动采用历史。保留未配置时的原生行为 |
| 0011 child-execution-environment | 原生 child 创建／续接提供可等待的执行环境准备与发布校验，显式选择目标 preset/cwd，保留普通 child 的 standing composition、原生 Session lineage 与工具过滤 |
| 0012 tool-execution-environment | 工具声明操作与资源元数据，使用可选调用环境的 cwd／文件引用；工具与文件输出 metadata、延迟预览和 URI 显示保留来源身份，terminal backend 可注入执行策略。原生工具调度、事件格式、job/terminal 生命周期保持不变 |

重建文档预览浏览器模块时，PDF.js 主模块、worker、字体／解码资源与许可证须一起保留，并与固定上游依赖版本一致；不能仅编译界面代码后沿用另一版本 worker。

新增补丁应直接服务执行身份、生命周期或 provider 接口；展示便利优先使用现有插件槽位。New Session 使用原生控件，Reload worlds 位于工作区插件，不再维护侧栏 primary actions 补丁。

补丁间有顺序依赖，尤其 0005/0006 也修改 Session controller；不要把“上游出现类似接口”直接当成可以删补丁。

## 升级顺序

1. 检查上表接口和原生本地行为，更新 series 及官方依赖锁；在隔离源码副本验证补丁与摘要。
2. 跑 **unchanged-source** gates，确认上游本身提供什么；再跑独立 **patched-host** gate，确认补丁提供什么。两者不能合并为一个“兼容通过”。
3. 构建扩展，用官方 CLI 安装同一 tarball；跑本机与双 Linux/SSH World 混合浏览器、冷恢复、child/terminal、当前格式历史恢复。浏览器代码另做类型检查。Standard preset 从固定上游派生；构建须排除误打包的外部 Cordis/scope 源码，原生 AgentPresets 的 standing mount 状态不能复制。
4. 通过后形成发行候选，成对更新 DSH 和扩展。

具体命令见 [开发指南](../development.md)；新消费者先对照 [消费者接入契约](../system-map.md#新增消费者与升级)。
