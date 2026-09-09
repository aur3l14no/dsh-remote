# 安装

使用官方 DeepSeek Harness **0.1.5-alpha.1**、Node.js **24.19+** 和 pnpm。扩展通过标准 `dsh plugin add` 安装到 Web profile；启动仍用官方 CLI。不编译 DSH，不修改其安装文件，不使用额外启动器或 Node 解析 hook。

```sh
dsh plugin --profile web add https://github.com/aur3l14no/dsh-remote/releases/latest/download/dsh-remote-extension.tgz
```

该地址指向最新正式 Release，自动下载并安装扩展，无需预先取得 tgz。附件名固定，包内保留实际版本；需要固定版本时，将 `latest/download` 换成 `download/v<版本号>`。下面是首次 World 配置与已有配置升级步骤。

完整发行包通过 GitHub Release 提供，无需 npm 发布。CI 在安装验收成功后产出 `dsh-remote-linux-x86_64.tar.gz`，内含扩展、Linux x86_64（glibc 2.36+）helper/ripgrep、许可。其他远端平台仍需自行准备匹配产物。完整包由 Release 工作流发布，见[发行流程](release.md)。

从本仓库 Release 获取归档，解压到单独目录。新配置先准备 `worlds.json`：

```json
{"worlds":[{"id":"dev","name":"Dev","target":{"kind":"ssh","host":"my-remote"}}]}
```

将 `my-remote` 换成已有 SSH alias；已安装扩展后，在解压目录执行（完整包须与已安装扩展为同一版本）：

```sh
dsh plugin --profile web exec dsh-remote-config init-release /absolute/path/release /absolute/path/worlds.json
dsh --profile web
```

`init-release` 校验扩展版本、上游 revision 和全部产物摘要，将 runtime 文件复制到 `$DSH_HOME/remote/artifacts`；初始化后不依赖下载目录。它只接受 `worlds` 配置，不填写 `bootstrap` 或 `bindingFile`，不会覆盖已有配置。

离线安装或开发验收可从解压的完整包执行 `dsh plugin --profile web add ./dsh-remote-extension-0.3.0.tgz`，再运行上述初始化。

已有自行准备的 manifest/cache 时，仍可用 `dsh-remote-config init WORLD_CONFIG.json`；该格式包含 `worlds` 和 `bootstrap`（见 [profile 说明](../integrations/dsh/packaging/extension/README.md)），不填写 `bindingFile`。技能选择与依赖准备见 [Skills](skills.md)。范围读取需要 helper **0.1.3+** 的 `fs.read-range` capability；旧 helper 会明确拒绝，需更新 bootstrap manifest 和 helper 产物。helper、ripgrep 和 bootstrap manifest 必须符合远端平台，不能用宿主架构猜测。模型凭据仍由官方 DSH 配置并留在宿主。

例如，已有 [bootstrap manifest 与本地 artifact cache](development.md) 时，可生成配置（将 `my-remote` 换成自己的 SSH alias）：

```sh
node --input-type=module - /absolute/manifest.json /absolute/cache > worlds.json <<'JS'
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [manifest, cache] = process.argv.slice(2);
console.log(JSON.stringify({
  worlds: [{ id: 'dev', name: 'Dev', target: { kind: 'ssh', host: 'my-remote' } }],
  bootstrap: { manifest: JSON.parse(readFileSync(manifest, 'utf8')), cacheDir: resolve(cache) }
}, null, 2));
JS
```

初始化命令在 `$DSH_HOME/remote/`（默认 `~/.dsh/remote/`）创建私有配置与绑定存储。目录已存在时拒绝覆盖；日后编辑 `config.json`，重启官方 DSH 生效。不要删除 `bindings.json`：它保存 Session → portable_workspace 的持久映射，普通启动不会重建丢失的映射。多个 profile 使用同一 DSH_HOME 时共享这份远端配置和绑定存储。

扩展会禁用本地 workspace、sandbox 及有关执行插件，提供远端 Web 与 agent preset。这会改变整个 Web profile 的行为；不是在默认本地模式中追加一个远端工具。父／子 Agent 使用所选 SSH 账户权限，不承诺 OS sandbox。具体边界见[执行边界](execution-boundaries.md)。

从旧源码入口迁移时，保留原来的 DSH_HOME 与绑定文件：将既有远端配置放到 `$DSH_HOME/remote/config.json`，其中 `bindingFile` 仍指向原文件的绝对路径，不重新初始化空映射。迁移前备份配置和状态。

更新时停止 DSH，备份整个 DSH_HOME 以及配置指向的外部 bindings/Session 存储；将官方 DSH 与扩展成对更新，再重启。已有配置不重复执行 init。此版本会把恢复的旧会话写成 V3，保留原 V2 日志；旧 DSH 不能读取 V3。回退需要使用备份状态，不能只降级 npm 包。

升级时解压新包并校验，安装新 tarball，将 `release.json` 中的 `manifest` 与 `artifacts/` 放入长期保留的本地目录，再更新既有 `config.json` 的 `bootstrap.manifest` 和 `bootstrap.cacheDir`；保留 worlds、bindings 和其他配置。不要重新 init。更新完成后重启。DSH 版本不匹配会明确失败，不能独立升级到未验收的官方版本。

```sh
dsh plugin --profile web remove @dsh-remote/extension
```

移除后 bundle overlay 随之消失，官方插件配置恢复；保留远端配置、绑定和 Session 历史。既有远端 Session 仍需要扩展才能正确执行，不应当作本地 Session 继续使用。

开发者使用同一 tarball 与安装命令，构建和验收步骤见[开发](development.md)。CI lockfile 只固定官方构建／测试输入，不作为用户安装协议。
