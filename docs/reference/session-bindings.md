# Session 与 World 绑定

[identity.ts](../../integrations/dsh/packages/world/execution-world/src/identity.ts) 定义执行身份；[bindings.ts](../../integrations/dsh/packages/world/execution-world/src/bindings.ts) 持久保存 Workspace definitions 与 Session ID → Workspace ID。JSONL 对话仍由 DSH 保存，绑定记录不含 helper runtime ID、resume token 或对话正文。

- `WorldDefinition`：执行环境 ID 与显式 local/SSH target，不含 cwd。SSH target 包含 host，以及可选 SSH 配置、安装/runtime 路径和固定 Podman container ID。
- `WorkspaceDefinition`：独立的 workspace `id`、所属 `worldId`、canonical `cwd` 与目标配置快照。通过选定 World 的 FS 解析路径后，用 `workspaceFor` 构造。
- Binding：Session 固定引用一个 Workspace。完整身份的指纹与比较集中在 identity.ts；颜色、显示名称、置顶和归档不参与执行身份。
- Runtime：本次连接的 helper 实例和资源 owner，不属于持久 Workspace 身份。

模型与审批共用的执行上下文显式提供 `world`（环境 ID）、`workspace`（工作区 ID）和 `kind`；SSH 另外提供 runtime 等运行事实。helper 协议已有的 `world` 字段仍承载工作区执行 owner ID，未变更协议线格式。

同名 cwd 不能标识同一 World，相同 workspace ID 的不同定义或已绑定 Session 改向都会拒绝。registry 的 `portable_workspaces` domain 保存 workspace 与 membership；`workspace_presentation` 独立保存置顶、归档。展示偏好更新不修改 workspace 时间戳或绑定。浏览器通过独立的 `followWorlds` stream 接收 World 展示快照，不依赖原生 workspace feed 为未改变的 workspace 发出事件；每次连接有初始快照，取消请求会释放订阅。

绑定存储格式为 v3：`{ version: 3, workspaces, sessions: [{ sessionId, workspaceId }] }`。缺失绑定明确拒绝。

```ts
// bindingFile 的父目录必须由本地账户私有管理；首次显式创建。
BindingStore.create(bindingFile);
await ctx.executionWorlds.bind(sessionId, definition);
// 再调用原生 agents.create，并在 setup 中 mount standing preset。

await ctx.executionWorlds.prepare(savedSessionId);
// 再调用原生 agents.resume；不恢复旧任务。
```

## 提交与失败

写入采用本地锁、私有临时 JSON、sync、rename 和目录 sync；读者看到完整 generation。文件有 4 MiB 限制。根绑定先于 Agent 创建提交；后者失败时保留绑定供同 World 重试，不承诺跨 binding 文件和 DSH 日志的事务。

新子 Agent 依据 parent Session metadata 继承，在 `agent/session-start` 落盘；该通知不能否决发布，因此提交失败可能留下已发布但模型上下文/工具均被阻止的 Agent。恢复要求已有记录。严格发布前原子准入是独立的下一阶段改动，不是当前保证。

缺失、损坏、非当前格式、悬空 binding 明确失败。rename 后目录 sync 失败报告不确定提交并阻止该 store 继续工作，重新打开再判断。强制终止写进程可能遗留锁；确认写者已退出后才能手工处理，不自动偷锁。

Agent dispose 不删持久绑定。宿主重启按 binding 重新组合本机 provider，或为 SSH 启动新 helper；同一 service 生命周期内不会静默替换失败 World。SSH alias/config 仍由 OpenSSH 解析，binding 记录选定坐标而不是独立的远端账户认证系统。
