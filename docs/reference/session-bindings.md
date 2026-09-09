# Session 与 World 绑定

`integrations/dsh/packages/world/ssh-world/src/bindings.ts` 持久保存 World definitions 与 Session ID → World ID；JSONL 对话仍由 DSH 保存。记录不含 helper runtime ID、resume token 或对话正文。

当前 v1 definition 包含 immutable ID、SSH host、canonical remote cwd，以及可选 SSH 配置、安装/runtime 路径和固定 Podman container ID。相同 ID 的不同定义或已绑定 Session 的改向都会拒绝。

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

Agent dispose 不删持久绑定。宿主重启读取 binding 并启动新 helper；同一 service 生命周期内不会静默替换失败 World。SSH alias/config 仍由 OpenSSH 解析，binding 记录选定坐标而不是独立的远端账户认证系统。
