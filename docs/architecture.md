# 架构与 DeepSeek Harness 的关系

DSH 是本地 Agent 宿主，负责模型路由、循环、Session JSONL、工具注册/过滤和委派。dsh-remote 提供远端执行与项目集成，通过下游补丁暴露环境接口、外部插件实现 World 策略。具体执行位置和权限见[执行边界](execution-boundaries.md)。

```text
本地 DSH Web / Agent / Session
  → portable_workspace(World, workspace) 与持久绑定
  → DSH FS / subprocess 能力接口
  → 本地 World owner + remote providers
  → TypeScript client → system OpenSSH → Rust helper
                                      → 远端 workspace / 子进程 / PTY
```

## 目录与职责

| 目录 | 职责 |
| --- | --- |
| `runtime/helper/` | 远端 Rust 文件、进程、PTY 和协议服务；独立 Cargo crate，拥有 manifest、lockfile 和默认 target/ |
| `runtime/client/`、`runtime/ssh/` | 本地 Node.js 私有 npm 包；分别处理协议及 OpenSSH/安装/bootstrap，不导入 DSH API |
| `runtime/tests/`、`runtime/scripts/` | 通用执行测试与产物准备/上传 |
| `integrations/dsh/packages/` | 按领域组织的四组模块，职责及源码入口见[模块索引](../integrations/dsh/packages/README.md)；统一发行 |
| `integrations/dsh/shared/` | 少量跨模块工具，不存 World/Session 领域逻辑 |
| `integrations/dsh/patches/` | 固定上游与有序补丁，不存完整上游源码 |
| `integrations/dsh/packaging/` | overlay、preset、初始化配置与官方构建输入 |
| `integrations/dsh/tests/`、`scripts/` | DSH 兼容验证与发行适配；原生缺口 fixture 和 patched-host 分开 |
| `docs/`、`.agents/notes/` | 当前使用契约，以及计划、决策和按时间保存的证据 |

生成产物按生命周期分开，位置与清理命令见[开发指南](development.md)。源码模块边界不等于独立 npm 发行或单一 Cordis 实例。

## 身份与生命周期

World catalog 描述环境；portable_workspace 是该环境中的 canonical workspace。v1 `WorldDefinition` 同时包含 SSH 坐标与 cwd，是具体执行绑定；registry 为每个组合生成 binding ID，保留其存储含义。

Session 恢复以持久绑定为权威，不以 UI 选择或同名路径为依据。子 Agent 继承绑定，沿 parent lineage 找到顶层 portable_workspace，逐级校验 cwd 和完整 binding；不会成为顶层成员。continuation 保留原生 child Session 与工具过滤。提交顺序及失败边界见 [Session bindings](reference/session-bindings.md)。

World、SSH 连接、helper runtime epoch 和 process ID 是不同身份。同一活跃 runtime 可在有限宽限期内重连；宿主重启准备新 runtime，不恢复旧句柄或重放命令。

## 装配与宿主接口

`packages/bundle/remote/src/index.ts` 按依赖顺序挂载同步服务、World owner、workspace feed、registry 和消费者。feed 与 Remote namespace 必须先于依赖它们的 controller/UI 激活。portable_workspace 替换原生 Workspace registry 与导航，session-admission 校验绑定并准备环境，ssh-world 提供执行能力。

FS、subprocess、shell 和 workdir resolver 在同一个 standing preset 隔离域中；Agents 加入该域，共享原生工具实例。原生 jobs/terminal 服务负责 Session owner 生命周期；terminal backend 将创建操作交给所属 World 的 subprocess。helper 管理底层资源，不接管 Agent 或审批策略。

`workspace/remote-attachments` 通过独立的 Session 身份入口选择持久源，不依赖工具 ALS。新附件存远端账户数据目录，模型转换/预览按需读回宿主；宿主仅保留可重建的请求变体。命名空间、旧宿主引用与大小限制见[附件契约](execution-boundaries.md#上传附件)。

[补丁说明](../integrations/dsh/patches/README.md)维护各宿主接口；[series.json](../integrations/dsh/patches/series.json)维护上游 revision、修改包及摘要。新增消费者遵循[插件兼容契约](plugin-compatibility.md)，升级风险与补丁移除条件见[上游依赖](upstream-dependencies.md)。

## 发行结构

官方 DSH 加标准 extension bundle 是统一安装方式。构建只编译受补丁影响的兼容包和本项目插件；overlay 按包内相对路径装配兼容实现，工具在 remote preset 中加载，其余服务和静态 Web 前端沿用官方 npm 产物。

兼容包的运行时引用在构建期指向同一份包内文件，保留 package、client factory 和 Typert 身份。ui-chat 的浏览器模块从补丁源码单独构建；DSH 按插件文件最近的 package.json 发现浏览器模块和 inventory。普通依赖通过官方 profile fallback 解析，不使用 Node resolve hook，不修改官方安装。配置插件在兼容服务激活前校验宿主版本。

安装与状态迁移见[开发文档](development.md#离线产物与已有配置)，overlay/preset 细节见[装配说明](../integrations/dsh/packaging/extension/README.md)。
