# Session 与 World 绑定

`integrations/dsh/packages/world/execution-world/src/bindings.ts` 持久保存 World definitions 与 Session ID → World ID；JSONL 对话仍由 DSH 保存。记录不含 helper runtime ID、resume token 或对话正文。

定义使用显式 `kind`：SSH 包含 immutable ID、SSH host、canonical cwd，以及可选 SSH 配置、安装/runtime 路径和固定 Podman container ID；local 只包含 immutable ID、`kind: "local"` 与 canonical cwd。相同 ID 的不同定义或已绑定 Session 的改向都会拒绝。

存储读取 v1（仅 SSH）和 v2（local/SSH）；首次写入 local 时，在写锁内先将 v1 原始字节写入私有 `bindings.json.v1-<sha256>.bak`，再发布 v2。备份存在时校验原字节，可从备份已完成而升级未发布的中断点重试。SSH 定义、Session ID 和原有 registry 身份不变。回退到仅支持 v1 的旧扩展前，应停止服务并恢复成套配置、绑定与历史备份，不能把含本机会话的 v2 直接交给旧扩展。

原生本机会话仅在首次采用时，依据原生持久 workspace membership、原始 header 和 canonical cwd 核对后绑定；子会话还需已确认的父链。不会从 cwd 推测环境，也不会把缺失 SSH binding 当作 local。记录采用完成标志后，丢失的 binding 必须显式恢复。原生 workspace ID、会话 ID 与原始日志保持不变。

身份不明或非 canonical 历史会话会报错：停止升级并保留备份，在原生 DSH 中选择实际目录创建新会话；需保留旧身份时，先修复可信 metadata／备份，再重新升级，不手工猜填 binding。

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

缺失、损坏、未来格式、悬空 binding 明确失败。rename 后目录 sync 失败报告不确定提交并阻止该 store 继续工作，重新打开再判断。强制终止写进程可能遗留锁；确认写者已退出后才能手工处理，不自动偷锁。

Agent dispose 不删持久绑定。宿主重启按 binding 重新组合本机 provider，或为 SSH 启动新 helper；同一 service 生命周期内不会静默替换失败 World。SSH alias/config 仍由 OpenSSH 解析，binding 记录选定坐标而不是独立的远端账户认证系统。
