# 单次跨 World 工具执行

Status: implemented

## 采用的设计

9 个现有工具接受 `execution_environment: { world, cwd }`，6 个 job/terminal 后续工具按资源 ID 继承创建环境。工具以声明式操作描述接入统一 `toolEnvironment`，FS、shell、subprocess、权限与审批事实共享同一次解析。Session header、binding、Workspace membership 和时间戳不变；原生工具调度器、事件格式与进程生命周期保留。

文件结果用原生 presentation metadata 保存明确的文件环境／引用，工具详情链接和延迟预览据此访问实际目标。显式引用核对 World 配置指纹。原生 API 创建的终端同样记录来源；本机 shell facade 保留 native Service 的 sandbox 上下文。

0012 涉及 12 个上游包，包含工具接口／消费者和必要的文件预览适配。runtime/helper 与独立审批回答者没有改动。当前契约见[工具执行环境](../../../../docs/reference/tool-execution.md)。

## 验收

基线：DSH 0.1.5-rc.1，revision `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。宿主为 macOS，真实 Docker Linux/SSH 双 World 与 Chromium；模型由 MockAdapter 控制。

- `npm test`：44 通过，2 个可选外部环境场景跳过。
- `npm run check`、`npm run test-integration`：最终通过，保留 unchanged-source 与 patched-host 独立 gate。
- `npm run test-e2e`：完整命令退出 0；安装／浏览器／本机入口与 11 个独立 Linux/SSH 场景通过，混合本机＋双 SSH 测试 2/2 通过。
- 最终 `--call-environment`：1/1 通过；覆盖 9 个选择目标的工具和 6 个资源后续工具、并发、相对 workdir、local/SSH 双向操作、完整参数事件、审批允许／拒绝与终端后续目标、Session／Workspace 不变、无效 World／目录、文件结果来源、相关文件读取及失效指纹拒绝。
- 实际点击工具详情与 present 文件预览读取 B，Session 仍绑定 A。工具详情、交付卡片和预览在 1365／390 宽度及 light／dark 下完成截图目视检查。原有 HTML、PDF 和图片预览回归通过。

私有日志：`.build/dsh/call-check.log`、`call-integration.log`、`call-full-e2e.log`、`call-final-e2e.log`。脱敏结果：`artifacts/dsh/call-environment-result.json`；截图使用 `call-tool-*`、`call-environment-*`、`call-preview-*` 前缀。runner 已清理测试容器、网络和临时凭据。结果不代表真实模型选参、其他平台或 GitHub CI 验收。
