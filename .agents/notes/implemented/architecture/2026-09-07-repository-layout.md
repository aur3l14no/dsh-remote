# Agent Note: Repository ownership and document lifecycle

Status: implemented

## Problem

Rust helper、DSH providers、实验、打包脚本和大量阶段性文档混在根目录，旧的 no-patch/延期 Web 决策容易被误当成当前目标。结构迁移必须保留现有运行契约，并使长期维护能定位 native package、plugin 与执行域。

## Decision

runtime/helper/ 是独立 Cargo workspace member；根命令、Cargo.lock 和 target/ 保持不变。runtime/client 与 runtime/ssh 是本地 TypeScript npm 包，与远端 Rust helper 共同构成 DSH 无关的执行层。用户进一步要求把这三部分归入一个目录，因此使用 runtime/，避免根 packages/ 与上游 DSH packages 混淆。DSH plugins、patches、profiles、实验、测试和发行脚本集中到 integrations/dsh/。补丁基线集中在 patches/series.json，序列为空。

README 和 docs/ 描述当前架构、执行边界和使用契约；proposed 中的当前阶段计划承载未完成事项，archived 保存早期文档与原始验收 JSON。采用 DSH notes 的 lifecycle/class/date-topic 思路，未引入它的翻译或生成工具链。

## Alternatives considered

**只添加新规划文档。** 保留混杂代码结构与多份 next-stage 状态会继续制造维护歧义。

**立即实现所有新 plugin 和 patch。** 本次范围是先整理并形成可验证的整体规划；未实现能力不创建空 package 或假配置。

## Consequences

源码路径与打包声明目录改变，公开 npm exports 的入口名称、helper 二进制名、协议和绑定格式不变。旧文档明确标为历史；其验收不是本次重跑结果。打包工具的源码边界需同时允许 runtime/client、runtime/ssh 和 DSH plugins，但不能包含测试或上游代码。

## Verification: initial layout migration

在临时完整副本中验证：cargo fmt --all --check、cargo clippy --locked --workspace --all-targets -- -D warnings、cargo build --locked、npm run check 均通过。npm test 为 25 passed / 2 environment-selected skipped；初次因 helper 尚未完成构建、随后因沙箱禁止 Unix socket 而失败，构建完成并授予本地 socket 权限后通过。

固定上游的 check-composition、session-routing 与 project-worlds 构建/原生运行通过；Project fixture 仍按预期复现未修复的两个 Web GAP。pack-plugin 产生 35 文件 tarball，check-plugin 声明与 export 检查通过；DSH_TEST_PACKAGED=1 的解包后 Loader 运行通过。打包验证发现并修复迁移脚本误改的一处上游 package.json 相对路径。

所有文档相对链接和静态 import 路径检查通过；10 份原始验收 JSON、Cargo.lock、package-lock.json 字节不变。完整 patched Web、真实浏览器/模型和 SSH/Linux 重新验收不属于本次结构变更完成声明。

## Runtime regrouping follow-up

把 helper/、packages/client/、packages/ssh/ 分别迁入 runtime/helper/、runtime/client/、runtime/ssh/。两个私有 npm 包名称不变；npm workspace 显式列出两个 TypeScript 包，lockfile 只更新 workspace 位置；Cargo.lock 保持不变。通用测试与产物脚本归入 runtime/tests/ 与 runtime/scripts/，根命令保留为开发入口，DSH 专用装配和发行保持在 integrations/dsh/。新增 Web Search 的重点验收计划不表示已经装配或测试通过。


归并后的验证已完成：Rust fmt/Clippy/build 与 TypeScript check 在上轮通过；恢复执行环境后，npm test 为 25 passed / 2 environment-selected skipped。固定未修改上游的 check-composition、session-routing/project-worlds 构建与原生运行、pack-plugin、check-plugin 和解包后 Loader 运行均通过。Project fixture 仍明确报告预期的本地 mkdir 与冷恢复两个 Web GAP。

34 份 Markdown 的本地链接与 TypeScript 相对导入检查通过；Cargo.lock 和 10 份原始验收 JSON 未变，package-lock.json 的语义差异仅为 workspace 路径。工具通道的 Too many open files 已恢复，未通过跳过检查来完成迁移。本次未执行 Linux/SSH、真实模型、浏览器或 Web Search 服务验收。


## Root cleanup

根目录只保留项目入口与 workspace 配置。通用测试和产物脚本移入 runtime/tests/、runtime/scripts/，同步 npm scripts、tsconfig、DSH fixture 和验收脚本引用。本地私有 justfile 移入忽略提交的 .local/justfile，根 justfile 仍可选导入；内容保持原字节，不执行私有同步命令。无当前引用的 23 份 VS Code 上游研究副本已按用户要求删除，不建立隐藏归档。target/ 和 node_modules/ 继续使用工具链的根目录约定。

验证：TypeScript check、npm test（25 passed / 2 environment-selected skipped）、固定上游 composition 类型检查与构建、插件声明检查通过。session-routing、project-worlds 与解包后 Loader 原生运行通过；Project fixture 保留两个预期 Web GAP。相对 import、Python 脚本语法、just 可选导入和私有文件忽略规则通过。Rust 源码、Cargo 配置与依赖未变，不重复其已通过检查；原始验收 JSON 保留历史路径与内容。
