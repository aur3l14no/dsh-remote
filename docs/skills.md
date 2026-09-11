# Skills 与项目指令

扩展从 Session 绑定的 World 发现项目 AGENTS.md 和 skills。local 复用 DSH 原生文件系统 skill provider、默认本机来源与 watcher，以及本机项目／个人指令；无需部署副本。SSH 使用下文的远端来源与同步机制，不扫描本机个人来源。模型、skill parser 和对话历史留在宿主。

本机 World 禁止 `skills`／`enabledSkills` 远端部署字段；目录 Reload 不触发本机 skill 复制。Skill 内容及所在目录不会改变会话的执行环境或权限。

## 同步选定 skills

在 [`$DSH_HOME/remote/worlds.json`](worlds.md) 的 World 条目中添加 `skills`（如下）。`source` 必须是本地绝对路径。本地连接编排层在新 helper/runtime 创建前同步；失败会阻止此次连接，修复后可重试。运行中编辑配置后使用 **Reload worlds** 预览并确认应用。

可设置 `enabledSkills: ["analysis"]` 只同步列出的已配置名称，`[]` 停止自动同步；通过 **Reload worlds** 确认应用时移除已配置名称的受管理启用链接，保留版本目录。省略时同步全部配置来源；选择只由当前配置决定。同一 SSH target 的 Worlds 必须声明相同来源和 `enabledSkills`。仅重启或独立部署不会卸载旧副本；要移除运行中配置不再选择的副本，使用带预览的重载流程。

没有 skill 来源文件 watcher；Web 界面检查 `worlds.json` 内容变化并提示重载。同一 runtime 的传输重连不触发同步；连接期间更新文件可手动点击 **Reload worlds**，或使用下方独立部署命令。独立部署命令读取自己的来源列表，不读取运行中服务的选择。

APM/chezmoi/skill-ops 继续管理本地来源、版本和适配。本项目复制配置中选定的完整 skill 文件夹，不运行 APM 或 skill 自带的安装脚本。同一 worlds 列表也可保存为 `.local/skills.json`，供下方独立部署命令使用：

```json
{
  "worlds": [{
    "id": "development",
    "name": "Development",
    "target": { "kind": "ssh", "host": "development" },
    "skills": [{
      "name": "analysis",
      "source": "/absolute/path/to/analysis",
      "requires": ["sh", "uv"]
    }]
  }]
}
```

```sh
node integrations/dsh/scripts/deploy-skills.mjs .local/skills.json
```

目标使用现有 SSH 配置，须为 Linux，具备 POSIX shell、tar、diff、find 和 GNU coreutils（含 stat、sha256sum、base64、sort）。`requires` 只检查远端 PATH 中的命令是否存在，不证明版本兼容；实际 CLI/runtime 版本与调用方式在 skill-ops 维护时确定。缺少依赖会在部署前失败，不自动安装 runtime、服务或凭据。

每份内容安装到 `$HOME/.local/share/dsh-remote/skills/<name>/<digest>/`，链接到 `$HOME/.agents/skills/<name>`。摘要包含文件路径、权限和内容。相同内容可重复部署；更新逐 skill 原子切换链接，旧版本保留。整个列表不是事务，后续条目失败时已完成条目不回滚；可修复后重跑。独立部署命令省略旧条目不会自动卸载；Web 重载会明确预览并确认受管理链接的移除，详见 [World 配置](worlds.md#预览与重载)。

已有版本会校验内容与文件权限，漂移时明确失败。已有普通文件、目录或其他管理器的同名链接不会被覆盖。部署锁冲突会明确失败；进程被 SIGKILL 时可能留下锁和暂存目录，确认无部署运行后再清理本项目拥有的路径。不要清理整个 home 或其他 manager 的目录。

同步按配置目标串行执行。远端 home 下的 skills 由同一 SSH 账户共享，不按 portable_workspace 隔离；相同 target 必须选择相同 skills。不同 SSH alias 若指向同一账户，也应由维护者保持配置一致。

选定源根可以是 APM 的链接，但内部必须是自包含的普通文件/目录；内部 symlink 和特殊文件拒绝。单个 skill 限 4096 个文件、32 MiB。请勿把含认证或私人配置的目录作为 skill 源。

## 发现与执行

项目根通过绑定 World 向上查找 `.git`，无标记时使用 Session cwd。当前 skill 来源优先顺序是项目 `.dsh/skills`、项目 `.agents/skills`、远端 home `.agents/skills`；同名时较前的来源优先。未隐式加载宿主 home、宿主 bundled skills 或默认本地 filesystem provider。

skill 使用原生 DSH frontmatter、调用权限、catalog 和 `skill` 工具。资源根指向远端真实目录，相对文档和脚本都从那里解析。读取说明不会授予额外执行权限：Shell 在绑定 World，已装配的网络连接器仍在宿主。

没有远端 watcher。remote profile 关闭 catalog 缓存，每次请求重新发现，下一次模型 pre-step 或 catalog 查询可见外部更新；已进入对话历史的说明不会被追溯替换。Session 身份参与 lookup；冷 catalog 先验证保存 binding，不为查询发布 Agent。

AGENTS.md/CLAUDE.md、对应 local overlay 与嵌套文件沿用原生 instruction 生命周期，通过显式 Agent provider 读取。全局 instruction home 当前为远端 `$HOME/.dsh`；不自动合并宿主个人 AGENTS.md。项目指令读取不是 Shell tool，因此不依赖 tools/execute 的临时路由上下文。

本地绝对脚本路径、宿主应用、浏览器扩展和认证配置不会随部署变得远端可用。需要这些能力的 skill 必须按 skill-ops 选择适配后的命令或独立本地连接器；不能自动改写 shell、回退宿主，或把远端文件路径直接传给本地应用。
