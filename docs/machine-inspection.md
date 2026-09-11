# 本机协调、跨 World 子 Agent 巡检

在本机 Workspace 的 Session 中，可以让 leader 按已配置 World 的 ID 或名称筛选目标，再启动原生远端 child。例：

> 找出配置中 node-* 的 SSH World，并发启动几个只读巡检子 Agent，收集系统和网络信息。等完成通知到达后汇总失败与缺失项，生成可悬停查看详情的机器地图并展示。

目标先在 [worlds.json](worlds.md) 中声明。`list_worlds` 只读配置目录，不自动导入 SSH config 中的所有 alias，也不扫描网络；OpenSSH 仍解析选中目标的连接配置。

## 模型工具

| 工具 | 行为 |
| --- | --- |
| `list_worlds(pattern?)` | 按 ID／名称 glob 查询已配置 World 与已登记 Workspace |
| `prepare_workspace(world_id, path?)` | 校验现有目录并登记 Workspace；SSH 省略 path 时创建私有临时目录，返回原生 `subagent` 可用的 `execution_environment` |
| `inspect_world(world_id)` | 准备 SSH 临时 Workspace，启动带只读工具过滤的原生 continuable child，返回 child ID；失败也记录到报告 |
| `inspect_machine()` | 在调用者绑定的 SSH World 上运行固定 Linux 探针，记录时间、系统、CPU、内存、网络接口、默认路由与磁盘信息 |
| `inspection_map()` | 把当前 leader 每个 World 的最近巡检结果生成到本机 Workspace，返回 HTML 路径；用原生 `present` 展示 |

巡检 child 只获得 `inspect_machine` 和原生 `send_message`，不能调用任意 Shell、文件写入或安装工具。准备阶段可能安装 helper/rg，并创建 `/tmp/dsh-inspect.*`；只读限制针对巡检阶段，不表示准备阶段没有写入，也不是远端 OS sandbox。普通显式委派不会自动应用巡检工具过滤。

child 使用原生 Team、父子导航、异步完成通知与消息续接。等待完成通知即可；报告可以在后续 child 完成后重新生成。重启后继续同一个 child 会使用保存的 World、Workspace 和工具过滤，不跟随 UI 当前选择。报告写入遵守 leader 当前的本机文件权限；read-only 模式会拒绝生成。报告是带时间的快照；连线只表示 leader 到目标的关系，不推断机器间拓扑或地理位置。

## 生命周期与失败

显式 `execution_environment` 只用于新建、空白上下文的 spawn child，值为已登记的 Workspace ID。普通 child 仍继承父级完整绑定。显式 child 保留原生 `origin=subagent`、parent Session 和深度，不加入 Workspace 顶层 Session 列表；普通孙级继承这个 child 的绑定。

启动前校验目标并持久保存 child 与 parent 的授权关系，然后挂载目标 preset、发现指令和创建原生 Agent。冷续接复查原生 parent header、绑定和 Workspace。目标不可用、绑定冲突或更换执行环境会明确失败。

探针缺失或不可用会显示 observation gaps；SSH 准备失败显示 failed；中断且没有已保存观测的 child 显示 interrupted，可查看原生对话或重新巡检。临时 Workspace 与绑定保留以便续接，结束 child 不自动删除远端目录。清理需另行显式处理。

固定探针当前面向 Linux。机器信息通过绑定 provider 读取；宿主保存 Session 历史和 `machine_inspections` 报告快照，模型请求仍在宿主执行。图中机器返回的文本按数据处理，不执行嵌入脚本。
