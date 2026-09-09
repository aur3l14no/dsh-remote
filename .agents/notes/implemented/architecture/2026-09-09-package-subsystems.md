# DSH 子系统目录迁移

Status: implemented

## 决定

采用用户确认的四组结构：`packages/world/ssh-world`、`packages/workspace/portable-workspace`、`packages/skill/remote-skills`、`packages/bundle/remote`。world 收录终端 backend 与账户策略，workspace 收录准入、文件引用和预览。API/UI 保留在 workspace 内，不另拆小包。

原 Skills 的通用取消等待函数迁至 `shared/lifetime.ts`。不新增 manifest 或独立发行单元；协议、持久化字段、Cordis 挂载顺序和已安装 bundle 中的 `plugins/web` 路径保持不变。新源码目录采用 kebab-case，已有测试场景、历史记录名称和兼容标识不随此次迁移改名。

## 取舍

不采用十余个细分子系统，也不把四组压成一个大模块。目录按领域聚合，模块内仍可有多个 Cordis 入口。共享 Session 解析的去重另行评估，本轮只迁移位置和相对引用。

## 验证

25 个迁移源码文件经比对，仅相对路径改变。通用 TypeScript、npm 测试（33 通过、2 个环境相关跳过）、上游 composition、低层 SSH 包构建及声明检查、Web 插件类型检查、完整扩展构建和安装/重复安装/版本拒绝/移除测试通过。新 tarball 安装后的双 Linux World SSH + Playwright 完整回归也通过；GitHub runner 结果以对应提交 CI 为准。

文档更新当前目录与责任分工，历史记录保留原时点叙述；失效的可点击源码链接指向迁移后文件。先前 adversarial review 的跨领域 lifetime 依赖已消除，其余关于共享身份契约的建议未在这次目录迁移中实施。
