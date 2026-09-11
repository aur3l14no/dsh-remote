# 原生跨 World child 与机器巡检

Status: implemented

## 实现范围

本机 leader 从已配置 World catalog 选择目标，准备 Workspace，通过原生 spawn/continuable child 委派。0011 提供可等待的执行环境准备与发布校验；显式 child 先保存绑定及 parent 授权，再初始化目标 preset。普通 child 继续继承父 Agent 已挂载的 standing composition。原生 Session、Team catalog、父子关系、消息、完成通知、深度和工具过滤保留；child 不加入顶层 Workspace membership。

绑定 v3 的可选 `parentSessionId` 表示显式执行边界。冷续接复查原生 header、parent 和目标 Workspace，不允许改变保存的执行身份。`machine_inspections` domain 保存每个 leader/World 的最近巡检快照；完整对话和生命周期仍归原生 Session。

巡检 child 只获得固定 Linux 系统／网络探针与消息工具。HTML 报告写入 leader 绑定的本机 Workspace，显式传递该 Session 的原生 sandbox policy，并通过原生 `present` 展示。地图支持悬停、键盘聚焦和窄屏布局；机器返回的文本按数据处理。

侧栏卡片在对应原生 Session 数据就绪前禁用打开操作，避免 membership feed 先到时选择未知 Session；不改变执行身份或 Workspace 时间戳。

## 验收证据

DSH 基线与补丁摘要以 `integrations/dsh/patches/series.json` 为准。本次使用 macOS、Chromium 和两个隔离 Docker Linux/SSH World；最终安装验证使用 `dsh-remote-helper` 名称。

| 验证 | 结果与证明范围 |
| --- | --- |
| `npm test` | 46 项中 44 通过，2 项为可选外部环境场景跳过；含显式 parent 绑定持久化、不可变性和损坏关系检查 |
| `npm run check`、`npm run test-integration` | 通过；后续修改另经 patched-host 与 Web 插件类型检查、相关行为 gate 验证 |
| patched-host child fixture | 普通 composition 继承、显式 SSH-kind child、只读工具过滤、普通孙级继承、发布拒绝、取消、完成通知和冷续接通过；sandboxed 报告在 workspace-write 下成功、read-only 下拒绝 |
| 安装态 `portable-workspace.e2e.ts` | 最终 1/1 通过；本机 leader 并发启动两个真实 SSH child，保存不同机器观测；宿主关闭重启后续接原 child，保留绑定和过滤；两个 epoch 均经模型回合调用原生 present，浏览器验证 HTML 悬停详情 |
| 地图浏览器测试 | 375／1200 宽度、24 节点、鼠标／键盘详情、无节点重叠、HTML 转义和无脚本异常通过；另目视检查六节点桌面布局 |
| 其他安装态分项 | CLI 安装／移除／版本拒绝、双 World admission、附件、Skills 部署、配置重载、附件 UI、extension-install 和 connect-install 通过 |
| 最终 `local-workspace.e2e.ts` | 2/2 通过；本机权限、上传、预览、cold restore 与同路径 macOS＋双 Linux/SSH 隔离 |

使用统一 `test-e2e` 入口准备并运行各层，修复后通过文档中的 focused entry points 重跑失败项。上述是分项最终结果，不声明最后一次完整统一命令整体退出成功，也不代表 GitHub CI 结果。

私有日志位于 `.build/dsh/child-environment/`：`tests.log`、`integration.log`、`patched.log`、`e2e.log`、`inspection-e2e.log`、`remaining-e2e.log`、`local-final.log`。标准安装态报告沿用 `artifacts/dsh/`。测试 runner 清理容器、网络与凭据。独立只读复审最终无 actionable findings。

## 边界

用法见 [机器巡检](../../../../docs/machine-inspection.md)。发现范围是配置 catalog，不自动导入任意 SSH alias 或扫描网络。准备阶段可能安装运行组件并创建临时目录；只读约束针对巡检工具，远端仍使用 SSH 账户权限，未提供 OS sandbox。临时 Workspace 保留以供续接，不自动回收。

地图是带时间的快照，连线只表示协调关系，不推断地理位置或机器间拓扑。模型输出由 MockAdapter 控制；SSH、helper、文件、进程、持久存储和浏览器路径真实执行。本次未调用用户个人目标或外部真实模型；其他平台、自动 worktree 和任意命令型巡检不在验收范围。
