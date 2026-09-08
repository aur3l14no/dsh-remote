# 源码安装与启动

第一版使用固定 revision 的 DSH 源码构建。需要 Node.js 24+、pnpm、Git 和源码构建依赖；目标 World 需要 SSH 与已准备的 Linux helper/rg 产物。独立 npm Web 发行延期。

从本仓库根目录执行；`DSH_SOURCE` 必须是 [series.json](../integrations/dsh/patches/series.json) 指定 revision 的干净 checkout：

```sh
npm ci
node integrations/dsh/scripts/prepare-web-host.mjs "$DSH_SOURCE" --production
node integrations/dsh/scripts/start-web.mjs init .local/remote-home .local/world-config.json
node integrations/dsh/scripts/start-web.mjs start .local/remote-home --no-open
```

构建不修改上游 checkout，只替换本仓库 `target/web-host` 并生成 Web plugins。`--production` 不应用测试 scaffold，也不安装 Chromium。运行中的宿主应先停止再重建；源码目录与 target 产物必须保留原位置，重建后的依赖布局须保持一致，不能把 symlink profile 当成可移动发行包。

`world-config.json` 使用 `{worlds, bootstrap}`，不含 `bindingFile`。worlds 是显式 World catalog（`id`、`name`、`target`），bootstrap 包含已准备的平台 `manifest` 与绝对 `cacheDir`；SSH target、产物准备及字段定义见 [bootstrap](reference/bootstrap.md) 与 [profile](../integrations/dsh/profiles/README.md)。配置中的文件路径使用绝对路径。安装不会猜测远端地址、下载未知二进制或自动部署 skills；选定 skills 使用[单独部署入口](skills.md)。

`init` 只接受不存在的新目录，其父目录须已存在；生成私有 home、空 bindings、remote.json 与原生 DSH profile。初始化失败时保留目录供排查，不会在重试时覆盖。此后启动只读取 bindings，丢失或损坏即失败；历史 home 必须整体备份/恢复，不能重新 init 掩盖丢失的映射。

在这个独立 home 中配置原生 DSH 的 `settings.yaml` 与 `.credentials.yaml`。最小配置可只保留 DeepSeek 默认模型及 `refs.DEEPSEEK_API_KEY`；凭据文件权限设为 0600。入口不会复制个人 DSH 配置或把凭据上传到 World。

`start` 直接启动构建后的 DSH CLI，加载 base + web-app + remote overlay，沿用原生认证 URL、浏览器打开行为和 `--port` / `--no-open` 参数。默认使用本地 loopback。控制台 URL 含运行期认证信息，不要提交或分享。停止入口会将 SIGINT/SIGTERM 转发给宿主。

父/子 Agent 均使用所选 SSH 账户权限；只支持 `danger-full-access`。这不是文件系统或网络 sandbox。终端工具与子 Agent 使用相同 portable_workspace；Git worktree 的创建与新 workspace 登记仍需单独处理。

源码启动显式传入 `--expose-internals`，使用固定上游 Loader 已有的配置锚点解析路径；当前本地验收为 Node 24.19，Node 内部接口变更需通过原生 CLI gate。入口仅透传上述 Web 参数以及 `--host`、`--trusted-host`、`--help`，不接受覆盖 profile 或追加任意 patch。

本 profile 禁用无法在远端强制执行的原生 sandbox 权限预设，不替换原生逐次审批机制。审批策略仍由 DSH 配置决定；未设置 `DSH_PERMISSION_MODE` 时默认 `ask`。

安装将生成包声明的依赖显式链接到 profile 的解析锚点，覆盖不在 CLI 默认依赖集合中的终端等消费者。同名依赖版本冲突会拒绝。这里不提供跨 revision 自动升级或迁移工具；不要通过重建一个空 home 来迁移历史 Session。
