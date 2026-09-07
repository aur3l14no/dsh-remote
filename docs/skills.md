# Skills 与项目指令

remote profile 从 Session 绑定的 World 发现项目 AGENTS.md 和 skills。模型、skill parser 和对话历史留在宿主；读取项目指令、skill 资源及执行项目命令使用远端环境。

## 部署选定 skills

APM/chezmoi/skill-ops 继续管理本地来源、版本和适配。本项目复制配置中选定的完整 skill 文件夹，不运行 APM 或 skill 自带的安装脚本。私有部署配置放在 `.local/`：

```json
{
  "worlds": [{
    "id": "development",
    "target": { "host": "development" },
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

目标使用现有 SSH 配置，须为 Linux，具备 POSIX shell、tar、diff 和 GNU coreutils。`requires` 只检查远端 PATH 中的命令是否存在，不证明版本兼容；实际 CLI/runtime 版本与调用方式在 skill-ops 维护时确定。缺少依赖会在部署前失败，不自动安装 runtime、服务或凭据。

每份内容安装到 `$HOME/.local/share/dsh-remote/skills/<name>/<digest>/`，链接到 `$HOME/.agents/skills/<name>`。摘要包含文件路径、权限和内容。相同内容可重复部署；更新逐 skill 原子切换链接，旧版本保留。整个列表不是事务，后续条目失败时已完成条目不回滚；可修复后重跑。省略旧条目不会自动卸载。

已有普通文件、目录或其他管理器的同名链接不会被覆盖。部署锁冲突会明确失败；进程被 SIGKILL 时可能留下锁和暂存目录，确认无部署运行后再清理本项目拥有的路径。不要清理整个 home 或其他 manager 的目录。

选定源根可以是 APM 的链接，但内部必须是自包含的普通文件/目录；内部 symlink 和特殊文件拒绝。单个 skill 限 4096 个文件、32 MiB。请勿把含认证或私人配置的目录作为 skill 源。

## 发现与执行

项目根通过绑定 World 向上查找 `.git`，无标记时使用 Session cwd。当前 skill 来源优先顺序是项目 `.dsh/skills`、项目 `.agents/skills`、远端 home `.agents/skills`；同名时较前的来源优先。未隐式加载宿主 home、宿主 bundled skills 或默认本地 filesystem provider。

skill 使用原生 DSH frontmatter、调用权限、catalog 和 `skill` 工具。资源根指向远端真实目录，相对文档和脚本都从那里解析。读取说明不会授予额外执行权限：Shell 在绑定 World，已装配的网络连接器仍在宿主。

没有远端 watcher。remote profile 关闭 catalog 缓存，每次请求重新发现，下一次模型 pre-step 或 catalog 查询可见外部更新。Session 身份参与 lookup；冷 catalog 先验证保存 binding，不为查询发布 Agent。

AGENTS.md/CLAUDE.md、对应 local overlay 与嵌套文件沿用原生 instruction 生命周期，通过显式 Agent provider 读取。全局 instruction home 当前为远端 `$HOME/.dsh`；不自动合并宿主个人 AGENTS.md。项目指令读取不是 Shell tool，因此不依赖 tools/execute 的临时路由上下文。

本地绝对脚本路径、宿主应用、浏览器扩展和认证配置不会随部署变得远端可用。需要这些能力的 skill 必须按 skill-ops 选择适配后的命令或独立本地连接器；不能自动改写 shell、回退宿主，或把远端文件路径直接传给本地应用。
