# SSH bootstrap 契约

`runtime/ssh` 提供 `bootstrapSshWorld`：使用 system OpenSSH 进入选定环境，检测目标平台，将可信 manifest/cache 中的 helper 与 ripgrep 上传安装，启动 runtime，协商协议并验证远程 rg 后返回 client。调用者负责可信 manifest 与本地产物来源；DSH 扩展在连接时自动取得匹配版本，通用 runtime 不依赖 GitHub 或 DSH。

```ts
const ready = await bootstrapSshWorld({
  host: selectedHost, world: selectedWorldId,
  manifest: trustedManifest, cacheDir: localArtifactCache,
});
// 将 ready.client 与 ready.ripgrep 交给该 World 的 Workspace providers；每次操作显式传 cwd。
await ready.close();
```

SSH 复用用户 keys、agent、ProxyJump 和 known_hosts，仅用 `-T` 保持协议字节流、`BatchMode=yes` 禁止后台交互提示；认证方式、主机密钥检查和 SSH 连接超时均遵循用户的 OpenSSH 配置。`configFile` 可显式指定配置；`podmanContainer` 可指定完整不可变容器 ID，使 probes、上传、runtime 和重连都在该最终容器进行。容器消失不能回退到 SSH 入口主机。

## 安装与校验

Manifest format 1 为目标 OS/arch/ABI 提供唯一 bundle，记录 helper/rg 版本、大小与 SHA-256。哈希验证传输完整性，不为不可信 manifest 创造来源可信度。缓存以摘要命名，上传前验证本地打开文件，远端再次验证字节和可执行版本。

默认 installRoot 是远端账户 `$HOME/.cache/dsh-remote`，runtimeBase 是 `/tmp`，均可显式配置。bootstrap 不接收 Workspace 或 cwd；集成层在借用 runtime 后校验 Workspace 目录存在且与保存的 canonical 路径一致。不要求远端编译器、sudo、公网或 SFTP；需要 POSIX shell 和基本工具。Bash 是否存在是具体 shell consumer 的要求，不是 bootstrap 的通用假设。

平台探测同时返回最终执行环境的账户 HOME（`ready.platform.home`），供集成层选取独立于安装缓存和 runtime 的持久数据目录；通用 runtime 不定义附件存储布局。

安装先写私有 generation，使用 publication lock 和原子 reference 发布。修复或升级生成新版本，不替换运行中的可执行文件。旧 World 保持其精确安装路径与 runtime；新准备不重放旧命令。中断写入、被强杀后遗留锁、generation 垃圾回收不由自动修复隐藏处理。

## runtime 与连接

同一 DSH 宿主进程按完整 World 配置指纹复用一个私有 runtime、Client 和 SSH 数据连接；并发首次连接合并。不同 Workspace 只持有目录与资源 owner，不分别启动 helper。协议 `world` 始终是真正的 World ID，不是 Workspace ID；runtime epoch 另行标识运行实例。API 2 不保存或协商 cwd，文件解析与进程调用显式传目录。协商验证 build、platform、arch 和 required capabilities；目标 rg 在远端账户 HOME 通过 subprocess 验证。默认 disconnect grace 30 秒、inbound lease 10 秒、连接/校验预算 15 秒；可按实现参数限制配置。

重连只恢复同一活跃 runtime。新 runtime 不恢复旧句柄、进程或请求执行。`close()` 先确认 shutdown，再清理该 World 的私有临时父目录；失败不会被报告为成功。控制 stdout、artifact 大小、socket path 和资源限制见实现及 [helper 协议](helper-api.md)。

控制命令的 POSIX quoting 与 Agent argv 分开；不启用隐式本地 shell。没有 readiness 就不提交 workspace 工作，连接失败不选本地 provider。

Workspace owner 关闭时取消自己的文件请求、释放文件流、进程与 PTY，再归还 runtime lease；其他 Workspace 的资源保持可用。最后一个 lease 归还才执行 shutdown；关闭期间新的 acquire 等待关闭结果，清理失败不能启动替代实例。尚未发布的连接失败允许下次重试，已经发布的失效 runtime 不自动换 epoch。Workspace provider 缓存在宿主服务生命周期内，关闭单个 Session 不等于释放 Workspace。

不提供跨 DSH 进程共享 daemon，也不额外管理 SSH ControlMaster 池。安装／探测仍使用短控制连接，日常协议请求在唯一数据连接内多路复用；重连替换传输但保持同一活跃 runtime。

发行包覆盖 Linux x86_64/aarch64（静态 musl）和 macOS aarch64。平台按远端 `uname` 探测，manifest 必须唯一匹配；本机 DSH 的 OS/CPU 不参与目标选择。发行产物与验收范围见[发行](../development/release.md)。
