# 文档与装配入口整理

Status: implemented

## 问题与决定

部分 README 仍描述早期实验；计划叠加了已被替代的源码安装方案。portable_workspace 的领域入口同时承担整个扩展的装配，维护者不易找到服务启动顺序。

将总装配移到 `integrations/dsh/plugins/extension/src/index.ts`，只调整 registry/API 相对导入，构建和类型检查入口同步。安装后的入口、浏览器模块身份和挂载顺序不变。保留 runtime / DSH 两层结构，不为整理引入新的运行机制。

packaging 首页解释完整扩展；低层 SSH fixture 另页说明。修正 plugin/admission/experiment 过时说明，开发指南按修改范围选择验证入口。当前计划只保留后续事项；已采用的一页纸约定归入 implemented/architecture，冻结补丁审计归档。历史验收和原始 JSON 不重写，文档迁移修复入链。

## 替代方案与后果

保留旧入口只改说明可以少移动文件，但仍把总装配藏在领域目录中；本次采用等价迁移。没有重组所有 scripts 或删除 unchanged-source 实验，它们仍证明独立的兼容边界。

## 验证与 review

主代理完成：迁移内容逐字比对（仅两条 import 调整）、插件类型检查、完整扩展构建、从新 tarball 安装的 package 身份/重复安装/版本拒绝/移除测试，以及双 Linux World SSH + Playwright 回归。所有 Markdown 本地文件链接（含 archived）存在，git diff 格式检查通过。

Subagent 无文件/终端工具，基于主代理提供的完整运行代码变更与文档变更说明做静态 review，未独立读取全仓或运行测试。未发现代码阻断项；指出冻结补丁审计仍放 proposed 的 P3，已移动至 archived。此 review 不等同于独立完整审计。
