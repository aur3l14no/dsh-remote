# DSH rc.2 与 Agent Teams

Status: implemented

## 决定与范围

固定官方 `0.1.5-rc.2` / `fb2c4b9e698e30edb738bca4cf0618587db7d203`；扩展版本为 `0.4.0`。标准与 SSH preset 装配 experimental Teams，协调状态、成员、任务和 mailbox 留在 DSH 宿主。Workspace 文件和进程继续使用成员绑定或单次调用环境。

0013 为 teammate 创建透传可选 Workspace ID，并按原生 origin 排除尚未写 descriptor 的 roster 外内部 worker。调用环境层仅解释声明 IO 能力的工具参数，其他工具的同名参数遵循自己的 schema。旧的全局子 Agent 控制工具退出 preset；普通 subagent 保留 one-shot，原生 continuable 服务仍保留用于恢复既有绑定。没有历史子会话或 Team roster 迁移。

0014 修复原生 Team 面板在窄屏被裁切的问题：使用现有 useAnchoredPosition 和 Portal，保留上游任务板与交互语义。

## 验收

- `npm run check`、`npm test`、`npm run test-integration` 通过。Node 快速测试 44 通过、2 环境条件跳过。
- `npm run test-e2e` 的准备、安装态/客户端测试与本机入口通过；更新旧 child fixture 的工具白名单后，`e2e.mjs --suite` 12/12 lane 通过。覆盖双 Linux/SSH、冷恢复、附件、skill 部署、配置重载、审批、单次工具环境、Teams、扩展与连接安装、本机浏览器。
- 新增 Teams lane：A 的 Lead 创建绑定 B 的队友，模型在 B 读文件并单次到 A 运行命令；队友认领/完成宿主任务，发送消息，空闲卸载后由消息冷恢复并再次读取 B。Lead binding 和 Workspace 时间戳保持不变；陈旧任务 revision 被拒绝。
- 加入 0014 后重新构建和安装隔离测试 profile，Teams lane 再次通过，包括桌面/390px、light/dark、刷新、窄屏编辑任务并验证宿主记录、窄屏打开队友会话。四张截图已人工检查：[截图](../../../../artifacts/dsh/agent-teams-ui/)。
- 最终产物的安装态/客户端检查 11/11 通过；最终补丁宿主 typecheck/bundle 与 Teams 浏览器源码类型检查通过。
- Teams 使用按 Session 分开的 MockAdapter；这不代表真实模型质量验收。任务 writeScopes 仍为共享相对路径提醒，不决定 World 或权限。

本记录描述本地实现与测试，不代表已发布或已升级用户正在运行的 DSH。当前契约见 [Agent Teams](../../../../docs/agent-teams.md) 和 [系统全景](../../../../docs/system-map.md)。
