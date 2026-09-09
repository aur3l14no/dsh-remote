# SSH bootstrap 契约

`runtime/ssh` 提供 `bootstrapSshWorld`：使用 system OpenSSH 进入选定环境，检测目标平台，将可信 manifest/cache 中的 helper 与 ripgrep 上传安装，启动 runtime，协商协议并验证远程 rg 后返回 client。调用者负责可信 manifest 与本地产物来源；DSH 扩展在连接时自动取得匹配版本，通用 runtime 不依赖 GitHub 或 DSH。

```ts
const ready = await bootstrapSshWorld({
  host: selectedHost, world: immutableBindingId, cwd: remoteWorkspace,
  manifest: trustedManifest, cacheDir: localArtifactCache,
});
// 将 ready.client 与 ready.ripgrep 交给 World providers。
await ready.close();
```

SSH 复用用户 keys、agent、ProxyJump 和 known_hosts，使用非交互公钥认证并严格检查已有主机记录。`configFile` 可显式指定配置；`podmanContainer` 可指定完整不可变容器 ID，使 probes、上传、runtime 和重连都在该最终容器进行。容器消失不能回退到 SSH 入口主机。

## 安装与校验

Manifest format 1 为目标 OS/arch/ABI 提供唯一 bundle，记录 helper/rg 版本、大小与 SHA-256。哈希验证传输完整性，不为不可信 manifest 创造来源可信度。缓存以摘要命名，上传前验证本地打开文件，远端再次验证字节和可执行版本。

默认 installRoot 是远端账户 `$HOME/.cache/dsh-remote`，runtimeBase 是 `/tmp`，均可显式配置。workspace 必须存在并远程规范化。不要求远端编译器、sudo、公网或 SFTP；需要 POSIX shell 和基本工具。Bash 是否存在是具体 shell consumer 的要求，不是 bootstrap 的通用假设。

平台探测同时返回最终执行环境的账户 HOME（`ready.platform.home`），供集成层选取独立于安装缓存和 runtime 的持久数据目录；通用 runtime 不定义附件存储布局。

安装先写私有 generation，使用 publication lock 和原子 reference 发布。修复或升级生成新版本，不替换运行中的可执行文件。旧 World 保持其精确安装路径与 runtime；新准备不重放旧命令。中断写入、被强杀后遗留锁、generation 垃圾回收不由自动修复隐藏处理。

## runtime 与连接

每个绑定启动独立私有 runtime。协商验证 build、platform、arch、canonical cwd 和 required capabilities；目标 rg 通过远程 subprocess 运行验证。默认 disconnect grace 30 秒、inbound lease 10 秒、连接/校验预算 15 秒；可按实现参数限制配置。

重连只恢复同一活跃 runtime。新 runtime 不恢复旧句柄、进程或请求执行。`close()` 先确认 shutdown，再清理该 World 的私有临时父目录；失败不会被报告为成功。控制 stdout、artifact 大小、socket path 和资源限制见实现及 [helper 协议](helper-api.md)。

控制命令的 POSIX quoting 与 Agent argv 分开；不启用隐式本地 shell。没有 readiness 就不提交 workspace 工作，连接失败不选本地 provider。
