# 安装

使用官方 DeepSeek Harness **0.1.3-alpha.2**、Node.js **24.19+** 和 pnpm。扩展通过标准 `dsh plugin add` 安装到 Web profile；启动仍用官方 CLI。不编译 DSH，不修改其安装文件，不使用额外启动器或 Node 解析 hook。

当前提供 CI 候选预构建 tarball，尚未发布 npm 或公开 Release。下载并解压 CI artifact 后：

```sh
dsh plugin --profile web add ./dsh-remote-extension-0.2.0.tgz
dsh plugin --profile web exec dsh-remote-config init /absolute/path/worlds.json
dsh --profile web
```

`worlds.json` 使用 `worlds` 和 `bootstrap` 字段（格式见 [profile 说明](../integrations/dsh/profiles/README.md)），不填写 `bindingFile`。技能选择与依赖准备见 [Skills](skills.md)。helper、ripgrep 和 bootstrap manifest 必须符合远端平台，不能用宿主架构猜测。模型凭据仍由官方 DSH 配置并留在宿主。

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

更新使用相同安装命令替换 tarball，然后重启。DSH 版本不匹配会明确失败，不能独立升级到未验收的官方版本。

```sh
dsh plugin --profile web remove @dsh-remote/extension
```

移除后 bundle overlay 随之消失，官方插件配置恢复；保留远端配置、绑定和 Session 历史。既有远端 Session 仍需要扩展才能正确执行，不应当作本地 Session 继续使用。

开发者使用同一 tarball 与安装命令，构建和验收步骤见[开发](development.md)。CI lockfile 只固定官方构建／测试输入，不作为用户安装协议。
