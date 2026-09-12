# CodeQL World IO：首次效用评估

Status: historical experiment (not current instructions or a compatibility gate)

迁移说明：原记录位于 `.agents/notes/implemented/integration/2026-09-11-codeql-world-io.md`。以下基线、实验结果与旧产物路径保留为历史证据，不作为当前扫描状态或操作入口。

## 结论与基线

CodeQL 可以用简短查询追踪原生 IO 实例、成员及输入的跨文件路径，明显比 import 清单更适合定位候选。但本次实验不能支持“自动可靠判定当前装配是否破坏 World 边界”。能力追踪、参数语义模型和实际装配是三个不同的问题；查询只能覆盖前两者的一部分。

本次固定 CLI 2.27.0、`codeql/javascript-all` 2.10.1，上游 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`，应用当时 `integrations/dsh/patches/series.json` 的 11 个补丁。本仓库基于 `1589411c6cd7bd1e6e533fea2c09bda8dc8b5446` 加未提交的检查器改动。运行于 macOS arm64；没有运行 Linux/SSH 或浏览器验收，没有提交或推送 GitHub CI。

核心仅为两个 path query 和一个共用数据流配置：原生模块 → callee，以及工具输入／`header.cwd` → 原生路径／命令参数。别名、跨函数值流、路径拼接、文件／进程参数模型交给 CodeQL。未加入插件 allowlist、现有发现基线 suppression、分支 sanitizer 或手写调用图。当前用法以 [World IO 数据流审查](../SKILL.md) 为准。

## 有标注调用点

先定义 25 个调用点的语义真值，再运行查询；按调用点去重，不按路径数统计。正例假定工具允许 SSH workspace，故无本机限制的直接原生工作区操作违反约定；本机 guard、宿主配置／日志和注入服务为反例。fixture 不执行 IO。

| 查询 | TP | FP | FN | TN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 原生能力调用 | 20 | 0 | 2 | 3 | 100% | 90.9% |
| Boundary 候选 | 14 | 1 | 5 | 5 | 93.3% | 73.7% |

已命中实例别名、命名导入别名、实例参数、返回实例、对象属性、跨文件包装器、promises 两种形式、动态 import、rename 目标参数、spawn cwd、命令输入和 Session cwd。`ctx.fs`、`ctx.subprocess`、同名普通对象、静态宿主配置路径和写入宿主日志的内容没有被当作 boundary 候选。

唯一 boundary FP 是先经 `executionWorlds.forAgent` 校验 live binding，再仅在持久 binding 的 `kind === 'local'` 时读取原生 FS 的分支：模型没有证明这个控制条件。这里不能用模型输入的 `args.world` 代替真实绑定，否则反例自身就不安全。5 个 FN 分别是：原生函数作为参数调用、re-export、动态方法名、不可见 SDK、没有显式来源的相对工作区路径。前两种与库的值流／sink 建模有关，后几种还涉及来源与可见性范围。能力查询已经能给出函数参数与动态方法名的调用路径，但 boundary 查询仍可能漏报；所以不能把 native 查询的覆盖当作 boundary 查询的覆盖。

这些是刻意覆盖常见传播方式和盲点的小样本，不是随机样本，不能外推成真实仓库 93.3% 的 precision。CI 以 native precision/recall ≥ 100%/90%、boundary ≥ 90%/70% 为回归下限，所有 FP/FN 继续显示；下限不是完备性承诺。

## 真实源码：从调用清单收敛到候选

补丁后上游产生 7,723 个原生能力结果、31 个 boundary 结果；31 个结果落在 31 个调用行，10 个生产源码、21 个测试／test-support。全量能力路径只保存在 SARIF，CI 只为生产候选给出汇总告警。与旧的 991 条上游 import 告警单位不同，不能称为减少了同一统计量的多少百分比。

人工核对全部 10 个生产候选：

| 位置 | 数据流证据 | 结合当前 remote 装配的判断 |
| --- | --- | --- |
| `packages/context/agent-instructions/src/files.ts:107,162` | Session cwd 经 root 查找／baseline 包装器进入 Node stat | 2 个 FP：当前 compose 取得 provider、缺失即返回；底层仅在 provider 未提供时用 Node。全局流未保留这个参数非空条件，remote 环境还显式提供 `owner.fs` |
| `packages/context/file-reference-local/src/search.ts:273,286,294` | Session cwd 经对象字段、目录计算进入 lstat/readdir | 3 个真实的本地实现接点，但 overlay 明确禁用 `file-reference-local`，由 remote file references 替换；不是当前 SSH 误路由证据 |
| `packages/subagent/subagent/src/out-of-process.ts:85,86` | parent Session cwd → resolveChildCwd → assertUsableCwd → isEnterableDirectory → statSync/accessSync | 2 个值得保留的兼容风险：外部后端若接 SSH，会先探测宿主同名路径；当前 remote 工具配置 `provider: spawn`，不证明这些外部后端可用 |
| `packages/subagent/subagent-acp/src/index.ts:94,95` | parent Session cwd 经自身验证函数进入 statSync/accessSync | 2 个同类外部后端兼容风险，当前 remote preset 不装配该 provider |
| `packages/acp/acp/src/index.ts:531` | 观察到的 Session cwd 经 sameDirectory 进入 realpath | ACP 自动化入口的本地目录语义；不在当前 Web remote 使用链路内，不能直接视为当前违规 |

因此不能将 10 个候选写成 10 个已确认的当前缺陷。若强行把它们全当“当前配置正在破坏边界”的告警，当前核对没有一个已确认 TP：2 个是调用条件丢失，其余 8 个缺少装配／暴露范围判断。真实仓库没有完整正例全集，不能计算全仓 recall；不能把其他未报的位置标为 TN。

本仓库分析的 boundary 结果全在本次 fixture，生产源码没有候选。这只说明当前来源／sink 模型未找到链路，不证明这些文件、动态服务装配或跨数据库依赖完整安全。

## 真实工具变异

在另一个完整的补丁后上游副本应用 [变异补丁](../tests/tool-io-mutants.patch)，未修改干净上游或实际插件实现，也未执行变异工具：

1. `read.ts:148` 将 `ctx.fs.readText` 改为原生 `readFile(input.filePath)`。能力查询和 boundary 查询均命中，后者给出 `args.file_path → parseReadArgs → input.filePath → unsafeReadFile` 的路径。它能发现实际工具里新增的直接绕过，不只是玩具 fixture。
2. `write.ts:2` 新增 `inspectNative(read, path) { return read(path) }`，从 execute 传入原生函数和 `input.filePath`。能力查询命中并包含实参到形参的传播；boundary 查询没有命中。与 fixture 的 FN 一致，不掩盖为通过。

两个真实变异的 boundary 结果是 1 TP / 1 FN；原生能力查询是 2 TP。变异旨在验证模型差异，不代表真实缺陷分布，也没有通过堆积特殊模型来把这两个例子做成全绿。

## 成本、提取质量与证据

这次 CLI 的 macOS 发行 zip 为约 1.09 GB（Linux x64 约 411 MB）；库和 CLI 可缓存。上游数据库的 baseline 为 683,110 行，提取约 88 秒再加约 30 秒 TRAP 导入。两个查询初次编译分别 39.4 / 48.6 秒，第一次上游求值分别 69 / 78 秒（并行，6 GiB 配额）。在已有数据库与缓存上，以 2 threads / 4 GiB 强制重求值为 14.8 / 28.1 秒，结果计数一致；这不是全新扫描耗时。源码脚本简单，但 CodeQL 工具链／完整扫描并不轻如 ESLint，适合 CI 而非每次保存文件执行。

提取仍发出一个包元数据问题：上游 `packages/llm/llm-retry/package.json` 重复 `@deepseek-ai/dsh-session-projection` key，CodeQL 未解析该 JSON。数据库建立成功不代表输入完全无损；该问题及其他未建模路径限制了全仓 recall 的判断。没有为让分析过关而修上游或忽略诊断。

原始证据写在忽略提交的 `artifacts/dsh/codeql/`：最终 fixture 是 `fixtures-verified/evaluation.json`、`fixtures-verified/results.sarif`；另有 `upstream/results.sarif`、`upstream/results-4gb.sarif`、`mutant.sarif`、`mutant-evaluation.json`、`repository-verified/results.sarif`、`series.json`。`experiment.json` 保留初次查询源码的摘要；`experiment-verified.json` 记录格式化后的查询、最终 fixture 和评估输入的摘要。数据库和提取日志在 `.build/dsh/`。复现时保留旧结果并选新工作目录，源码未提交时不要把本地证据称为 GitHub CI 验收。

## 2026-09-11 后续：间接调用的极简兜底

本节追加后续结果；上面的首次评估和旧产物保持不变。

不增加参数角色传播模型、调用图或 suppression。boundary sink 只增加 5 行（含注释）：在已有 `isNativeIoCall` 条件内，若调用不属于文件／进程模型，允许任意实参成为候选 sink。报告要求复审参数角色；已建模 API 仍使用原有路径／命令参数规则。

新建 fixture 数据库验证 26 个标注调用点：函数参数读取从 FN 变为 TP；新增独立 `invoke(console.log, args.path)` 包装器在 native/boundary 查询均为 TN。评估器对这两个用例增加明确断言。直接写日志内容仍为 TN，动态方法用例也由 FN 变为 TP。native 为 20 TP / 0 FP / 2 FN / 4 TN；boundary 为 16 TP / 1 FP / 3 FN / 6 TN。没有新增 fixture FP，已有 guarded-local FP 保留。

原真实工具变异数据库通过 `database analyze --rerun` 强制重求值：boundary 调用位置从 32 增至 34，没有消失项。新增 `packages/fs/tool-fs/src/write.ts:2`（目标间接读取变异）及 `packages/sandbox/sandbox/src/roots.ts:36`（`realpathSync.native(path)`，保留待审查）。首次未加 `--rerun` 时 CLI 复用了旧结果；上述数字来自随后强制重求值。

证据：`artifacts/dsh/codeql/invoke-minimal/{results.sarif,evaluation.json,evaluation.md,summary.md,mutant.sarif,mutant-diff.json}`；新 fixture 数据库在 `.build/dsh/codeql-invoke-minimal/database`。

只验证独立读取／日志包装器的区分。共享包装器混用多种函数时，只报告内部调用点的可能能力，不保证逐次调用上下文的精确区分；未建模包装器接收的内容也可能成为候选。接受人工／agent 判断，避免扩展扫描器。未运行插件、IO fixture、Linux/SSH 或浏览器验收，未提交／推送。

## 2026-09-11 后续：收拢维护范围

按用户确认的极简方案，保留 87 行 QL、23 行扫描脚本和一页 `docs/reference/node-io-inventory.md`。删除评估器、oracle 清单和 Markdown 报告生成器；原 fixture 收拢为一个文件的 8 个关键用例，28 行 `check.mjs` 直接核对 SARIF。没有候选状态库、语义 diff、precision／recall 门槛；唯一扫描报告是 SARIF。CI 继续校验工具链及上游补丁身份、运行回归并扫描本仓库和补丁后上游。

新建 `.build/dsh/codeql-simple/database` 完成提取和查询，`npm run test:world-io -- artifacts/dsh/codeql/simple/results.sarif` 的 8 个用例通过。另检查 Shell／Node 语法、workflow YAML 和 diff 空白。查询逻辑未改，本轮未重扫上游或运行远端／浏览器验收，未提交／推送。此前实验数字、历史文件路径及忽略目录内的原始产物保留为当时证据；不再维护旧评估入口。
