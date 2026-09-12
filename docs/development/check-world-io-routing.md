# 检查文件与进程操作的 World 路由

用 CodeQL 查找可能绕过 World 路由的本机文件及进程调用。结果供人工排查，不能证明路由完全正确。

## 何时运行

新增或修改文件／进程消费者、调整执行环境路由，或升级 DSH 时运行。push／PR 的 [CI](../../.github/workflows/node-io.yml) 检查小回归集，扫描本仓库及按 `series.json` 校验补丁后的固定上游，上传 SARIF 和补丁身份；分析失败或回归断言失败才使 job 失败。

## 如何运行

安装并校验官方 CodeQL CLI **2.27.0**，加入 PATH；查询库由 [lockfile](../../integrations/dsh/checks/codeql/codeql-pack.lock.yml) 固定。CLI 放在仓库外；若放在仓库内，其安装目录需独立的 CommonJS package scope。

```sh
codeql pack ci integrations/dsh/checks/codeql --common-caches=.build/dsh/codeql-cache
bash integrations/dsh/checks/codeql/scan.sh . .build/dsh/codeql-run artifacts/dsh/codeql/run

# 小回归集：只分析，不执行 fixture 中的 IO
bash integrations/dsh/checks/codeql/scan.sh integrations/dsh/tests/codeql/fixtures .build/dsh/codeql-test artifacts/dsh/codeql/test
npm run test:world-io -- artifacts/dsh/codeql/test/results.sarif
```

参数为 `SOURCE_ROOT WORK_DIRECTORY REPORT_DIRECTORY`；重跑选新的工作目录。可设置 `CODEQL`、`CODEQL_COMMON_CACHES`、`CODEQL_THREADS`、`CODEQL_RAM`（默认 2 threads / 4096 MiB）。无需安装目标工程依赖或构建目标；全量扫描需要几分钟。

## 结果解读

两项 QL 查询提供审查线索：`native-io-use` 跟踪 `fs`／`fs/promises`／`child_process` 能力到最终调用；`workspace-to-native-io` 跟踪工具输入／`header.cwd` 到原生 IO 参数。已建模调用只取路径、命令、argv、cwd；未建模调用允许任意实参成为候选，参数用途交给人工／agent 判断。复用 CodeQL 全局数据流，不维护调用图、白名单或候选状态库。

唯一报告为 `REPORT_DIRECTORY/results.sarif`：先看 `workspace-to-native-io` 候选及输入路径，再用 `native-io-use` 核对能力来源。用支持 SARIF codeFlows 的查看器，或让 agent 读取 JSON、对应代码和 Git diff；判断输入是否代表工作区目标，以及当前 World、guard、preset／overlay 是否允许执行该调用。测试也保留在结果中。

**候选不等于违规，零候选不证明安全。** 没有自动语义 diff、永久 suppression 或 precision／recall 门槛。

## 局限

| 类型 | 情况与审查要点 |
| --- | --- |
| FP：条件／装配 | 本机 guard、非空 FS provider、已禁用插件仍可能报；检查实际绑定和可达分支，不能只看插件源码存在。 |
| FP：参数用途 | 未建模调用中的输入可能只是日志内容；检查哪个参数决定 IO 目标。已建模的 `writeFile(fixedPath, input)` 内容不报。 |
| FP：共享包装器 | 同一包装器接收读取和日志函数，内部调用点有原生能力不表示每次调用都执行 IO。独立 `invoke(console.log, path)` 不报，`invoke(readFileSync, path)` 应报。 |
| FP：输入来源 | `header.cwd` 是字段形状匹配；工具输入也不一定属于远端工作区，需读上下文。 |
| FN：来源／传播 | 隐式相对路径、部分 re-export、动态方法／反射或未建模服务可能漏掉；函数值能追到也不保证路径语义正确。 |
| FN：不可见实现 | 外部 SDK、动态装配、跨数据库调用关系不完整；检查提取日志，建库成功不代表所有源码／元数据都解析成功。 |

数据库和 `extraction.log` 留在工作目录，数据库含源码归档，不上传。[历史实验与原始评估](../../.agents/notes/implemented/integration/2026-09-11-codeql-world-io.md) 保留当时结果，不作为当前指标体系。
