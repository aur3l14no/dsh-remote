# World 与 Workspace 配置

扩展首次启动会在 `$DSH_HOME/remote/worlds.json` 创建可编辑的 World 目录。已有安装会从 `config.json` 复制原来的 `worlds`，保留会话、注册目录和绑定；文件存在后以 `worlds.json` 为准。`config.json` 中的 `bindingFile`、bootstrap 和绑定存储仍由宿主维护。

可以让 Agent 协助编辑这个宿主配置文件。运行中的 Web 界面检测到内容变化后显示 **Worlds config changed. Reload?**；点击后预览并确认应用，不需要重新安装扩展、重启服务或重新初始化绑定。

```json
{
  "worlds": [
    {
      "id": "development",
      "name": "Dev server",
      "color": "#60a5fa",
      "target": { "kind": "ssh", "host": "dev-server" },
      "workspaces": [
        { "name": "Website", "path": "/home/dev/website" },
        { "name": "Backend", "path": "/home/dev/backend" }
      ]
    },
    {
      "id": "research",
      "name": "Research",
      "color": "#a78bfa",
      "target": { "kind": "ssh", "host": "research-server" },
      "workspaces": [
        { "name": "Experiments", "path": "/workspace" }
      ]
    }
  ]
}
```

- `id`：稳定且唯一的 World 身份。已有会话使用的 `id` 和 SSH target 不应改成另一个环境；更换主机时新增 World。
- `name`：World 显示名称。
- `color`：可选的六位十六进制颜色，用于会话卡片和选择器的 World 图标。未设置时保留旧版保存的颜色，默认蓝色。
- `target`：沿用现有 World 连接参数。`host` 可以是 SSH alias 或 `user@host`；使用已有 OpenSSH 配置、公钥认证和 `known_hosts`。开发环境也可显式设置 `configFile`。
- `workspaces`：新会话选择器中的目录列表。`path` 必须是远端绝对路径，目录必须已存在；`name` 可省略，默认使用目录名。不同 World 可以声明相同路径。
- `skills`、`enabledSkills`：可选的同步来源和名称选择，详见 [Skills](skills.md)。

点击 **New Session**，在输入框上方点击 **Choose workspace**，按 World 分组选择 Workspace。只有选中的目录会建立连接、安装所需 runtime 并检查远端真实路径；一个暂时离线的 World 不会阻止浏览其他选项。失败显示在选择菜单中，修复后可再次选择。

已有会话始终按保存的 World × canonical Workspace 恢复。选择另一个 Workspace 会打开该目录的新会话或复用其空白会话，不会修改原会话的绑定。会话卡片显示 World / Workspace、标题和目录，长文字截断，悬停可查看完整标题、World 和目录；悬停或键盘聚焦时显示置顶与归档图标。置顶会话排在列表顶部，重启后保留；归档同时取消置顶，保留历史和远端文件。

旧配置未声明 `workspaces` 时，选择器继续展示该 World 已注册的目录。显式设置 `workspaces: []` 会隐藏该 World 的新会话选项；移除一个声明不会删除远端文件或历史会话。`worlds.json` 只声明待选目录，不是 binding 存储，也不授予 Agent 通用宿主 Shell 权限。

## 预览与重载

侧边栏的 **Reload worlds** 也支持手动检查：即使 `worlds.json` 没变，也能同步本地 skill 来源的内容更新。界面每两秒检查配置状态；没有 skill 来源文件 watcher。

点击入口后，dialog 展示 World/Workspace 的增删改、每个目标上 skills 的新增、更新、移除或未变化，以及来源、版本和文件／目录的新增、修改、删除列表。较大的路径列表会截断显示，并保留完整变更数量。预览只读取远端状态，在宿主私有临时目录固定待部署内容；不会部署 runtime、安装 skill 或删除远端文件。配置错误、依赖缺失、同名目录不属于本扩展、已存版本漂移等会阻止应用。

**Cancel** 保留当前运行配置与远端状态。**Apply changes** 应用预览时固定的内容，展示进度与逐项结果。预览十分钟后过期；另一窗口创建新预览、配置变化或远端内容/权限变化时，旧预览不能继续应用。取消或过期会清理宿主暂存内容。

Skills 只移除本扩展管理的 `$HOME/.agents/skills/<name>` 链接，保留版本目录；名称与配置目标明确列在预览中。操作按目标串行，跨目标不是事务。部分失败时保留已完成项，当前运行目录保持旧配置，并暂停自动 skill 同步；修复问题后重新预览、应用即可完成。未变化的 skill 不重复上传。此流程与独立部署命令共享远端部署锁。

移除 World 或 Workspace 只移除新会话入口；旧 Session 仍按保存的绑定恢复。热重载拒绝把已有 World ID 改为另一 SSH target，需使用新 ID。Skills 在同一远端账户下共享，移除 World 时列出的 skill 移除也会影响已有 Session 的后续发现；已进入会话历史的说明不会被追溯替换。
