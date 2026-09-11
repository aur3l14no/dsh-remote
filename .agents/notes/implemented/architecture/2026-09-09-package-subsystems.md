# 仓库与子系统结构

Status: implemented

本页汇总 2026-09-07 至 09-09 的目录决策；验收描述各次迁移当时的结果。当前目录与生成产物位置见[系统全景](../../../../docs/system-map.md)和[开发指南](../../../../docs/development.md)。

## 决定与取舍

通用 helper、client 和 SSH 库归入 runtime/；DSH 插件、补丁、装配、测试和发行适配归入 integrations/dsh/。helper 保持独立 Cargo crate。选择这两层结构，避免把本仓库的 TypeScript 库误当成 DSH 上游包。

DSH 源码按 world/ssh-world、workspace/portable-workspace、skill/remote-skills、bundle/remote 四组组织，统一发行。总装配从 workspace 领域入口移出；通用取消等待归 shared/lifetime.ts。小适配器仍有独立 Cordis 生命周期，不因目录合并而合并服务实例；不采用十余个细分包或一个大模块。

原 experiments 归 tests/integration，直接引用维护中的 registry；低层 SSH package 仅作 unchanged-source fixture。overlay、preset 与初始化模板归 packaging/extension，源码布局对应安装布局。目录变化保持 npm exports、协议、Session 绑定格式、持久化 v1 字段和安装后模块身份不变。

当前说明归 docs/，计划和有长期价值的证据归 notes。早期“不改上游、延期 Web”方案已被替代；不保留多份下一阶段计划或按轮次追加的目录整理流水账。

## 历史迁移验收

| 阶段 | 结果与范围 |
| --- | --- |
| 09-07 初始目录整理及 runtime 归并 | Rust fmt/Clippy/build、TypeScript、npm（25 通过、2 个环境选择跳过）、原生 composition、SSH 包声明及解包 Loader 通过。保留 portable_workspace 的两个原生 Web GAP；未重跑 Linux/SSH、浏览器或真实模型。Cargo.lock 与 10 份原始 JSON 字节不变，npm lockfile 仅 workspace 位置变化。 |
| portable_workspace 术语统一 | 原生 composition、打包/声明及解包 Loader 通过；改名前写入、改名后恢复数据的 fixture 验证 v1 metadata、Session JSONL 与 bindings 不需迁移。 |
| 09-09 总装配提取 | 仅两条 import 调整；插件类型、扩展构建、原生安装/重复安装/版本拒绝/移除和双 Linux SSH + Playwright 通过。 |
| 四组模块与辅助目录归并 | 25 个源码文件仅相对路径变化；TypeScript、npm（33 通过、2 个环境选择跳过）、composition、低层包声明、扩展构建/安装及双 World 浏览器通过。后续模板归位另通过 patched-host 构建、包声明与安装检查；模板与 SSH manifest 字节不变。 |

这些是原记录的验收摘要，不是本次文档合并重跑的结果。目录整理 review 基于提供的代码及说明，未独立读全仓或运行测试；不能视为独立完整审计。GitHub 结果以对应 revision 的 Actions 为准。
