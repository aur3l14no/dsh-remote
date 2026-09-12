# Session 与 World 绑定

[identity.ts](../../integrations/dsh/packages/world/execution-world/src/identity.ts) 定义执行身份；[bindings.ts](../../integrations/dsh/packages/world/execution-world/src/bindings.ts) 持久保存 Workspace definitions 与 Session ID → Workspace ID。JSONL 对话仍由 DSH 保存，绑定记录不含 helper runtime ID、resume token 或对话正文。

- `WorldDefinition`：执行环境 ID 与显式 local/SSH target，不含 cwd。SSH target 包含 host，以及可选 SSH 配置、安装/runtime 路径和固定 Podman container ID。
- `WorkspaceDefinition`：独立的 workspace `id`、所属 `worldId`、canonical `cwd` 与目标配置快照。通过选定 World 的 FS 解析路径后，用 `workspaceFor` 构造。
- Binding：Session 固定引用一个 Workspace。完整身份的指纹与比较集中在 identity.ts；颜色、显示名称、置顶和归档不参与执行身份。
- Runtime：同一宿主进程内按 World 配置共享的 helper 实例、Client 与 SSH 数据连接；epoch 不属于持久 Workspace 身份。每个 Workspace view 单独拥有目录、取消与资源清理范围。

默认调用时，模型与审批共用的执行上下文显式提供 `world`（环境 ID）、`workspace`（工作区 ID）和 `kind`；SSH 另外提供 runtime 等运行事实。helper API 2 的 `world` 同样使用真正的 World ID。Workspace ID 仅用于 Workspace/binding；文件目标由 World ID、runtime epoch 与 canonical path 标识。

[单次工具执行环境](tool-execution.md)可以临时覆盖 World/cwd。此时上下文报告实际 World/cwd，不虚构 Workspace ID；Session binding、指令和附件存储归属保持不变。调用环境也不持久登记新的 Workspace。

同名 cwd 不能标识同一 World，相同 Workspace ID 的不同定义或已绑定 Session 改向都会拒绝。展示状态独立于执行身份与 workspace 时间戳。membership 使用原生 feed，World 展示通过 `followWorlds` 推送：连接时提供完整快照，取消时释放订阅。

绑定存储格式为 v3：`{ version: 3, workspaces, sessions: [{ sessionId, workspaceId, parentSessionId? }] }`。缺失绑定明确拒绝。

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

原生 spawn child 通过 0011 的可等待环境入口，在 Agent 创建／指令发现前保存绑定，发布时再次验证。普通 child 继承父级完整绑定；显式选择 Workspace 的新 child 同时持久保存不可变的 `parentSessionId`，作为执行边界授权。该 parent 必须已有绑定，悬空或循环关系拒绝读取；原生 child header 也必须匹配。沿 lineage 查询时仅在此显式边界使用自身 Workspace，不添加顶层 membership。恢复不允许重新选择 Workspace。其他未使用此入口的原生生命周期仍由 World 准入与工具上下文检查约束。

绑定与原生 Session/catalog 不跨存储事务：后续创建或发布失败可以留下已绑定但未发布的 child ID；不能用该 ID 改向重试，应创建新 child。

缺失、损坏、非当前格式、悬空 binding 明确失败。rename 后目录 sync 失败报告不确定提交并阻止该 store 继续工作，重新打开再判断。强制终止写进程可能遗留锁；确认写者已退出后才能手工处理，不自动偷锁。

Agent dispose 不删持久绑定。宿主重启按 binding 重新组合本机 provider，或为 SSH 启动新 helper；已发布的 runtime 在同一 view 生命周期内不会因失效而静默替换；尚未完成的连接失败允许下一次准入重试。SSH alias/config 仍由 OpenSSH 解析，binding 记录选定坐标而不是独立的远端账户认证系统。
