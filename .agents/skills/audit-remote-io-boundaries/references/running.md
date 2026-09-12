# 运行与维护

以下命令从仓库根执行。Node.js 24+；官方 CodeQL CLI 固定 2.27.0，查询依赖由 `../codeql/codeql-pack.lock.yml` 固定。CLI 放在仓库外，按当前平台下载官方发行并校验 checksum；CI 的 Linux 安装由 `../scripts/install-cli.sh` 执行。不安装或构建待扫描目标的依赖，也不执行 fixture 中的 IO。

```sh
skill=.agents/skills/audit-remote-io-boundaries
scan_dir=$(mktemp -d "${TMPDIR:-/tmp}/dsh-world-io-scan.XXXXXX")
codeql pack ci "$skill/codeql" --common-caches=.build/dsh/codeql-cache
bash "$skill/scripts/scan.sh" "$skill/tests/fixtures" "$scan_dir/fixtures" "$scan_dir/reports/fixtures"
node "$skill/tests/check.mjs" "$scan_dir/reports/fixtures/results.sarif"
bash "$skill/scripts/scan.sh" . "$scan_dir/repository" "$scan_dir/reports/repository"
node "$skill/tests/check.mjs" "$scan_dir/reports/repository/results.sarif" "$skill/tests/fixtures/cases.ts"
node "$skill/scripts/prepare-upstream.mjs" "$scan_dir/upstream" "$scan_dir/reports"
bash "$skill/scripts/scan.sh" "$scan_dir/upstream" "$scan_dir/upstream-db" "$scan_dir/reports/upstream"
```

`scan.sh SOURCE_ROOT WORK_DIRECTORY REPORT_DIRECTORY` 要求三个路径；每轮选新的工作目录。它输出 `REPORT_DIRECTORY/results.sarif`，数据库和 `extraction.log` 留在工作目录。环境变量 `CODEQL` 可指定 CLI，`CODEQL_COMMON_CACHES` 可指定缓存；默认缓存 `.build/dsh/codeql-cache`，默认 2 threads / 4096 MiB，可用 `CODEQL_THREADS` / `CODEQL_RAM` 调整。

`prepare-upstream.mjs NEW_SOURCE_DIRECTORY REPORT_DIRECTORY` 从仓库的 `integrations/dsh/patches/series.json` 取固定上游，检出到新目录、校验每个补丁 SHA-256 后应用，并把 series.json 放入报告目录；不修改日常开发的上游副本。它需要 Git 网络权限。

CI 同样使用 runner 的临时目录。CLI/查询库缓存与每次扫描数据库、报告分开；下载已有 CI 结果无需安装 CLI。报告不会写入仓库 `artifacts/` 或 skill 目录。

## 复用 CI 已生成的初筛报告

CI 的 `.github/workflows/node-io.yml` 调用上面的同一套扫描程序；Actions artifact 是其输出的存放位置，不是另一种扫描来源。用户指定查看 CI 时，从匹配运行中下载报告，无需重新安装 CLI：

```sh
gh run list --workflow node-io.yml --limit 10 --json databaseId,headSha,status,conclusion,url
# 选定与用户目标对应的 run 后，将 RUN_ID 替换为实际编号：
review_dir=$(mktemp -d "${TMPDIR:-/tmp}/codeql-io-review.XXXXXX")
gh run view RUN_ID --json headSha,status,conclusion,jobs,url
gh run download RUN_ID --dir "$review_dir"
```

核对 run 的 headSha、artifact 的 series.json 与各 SARIF invocation/诊断。按相同提交和补丁状态取得源码，再进入 agent 审查。CI 只上传候选报告，没有 upload-sarif 或自动 agent 解读步骤；不能用 Actions 成功状态或 GitHub Security 页是否有告警代替审查。

本地扫描记录 `git rev-parse HEAD`、工作区是否有未提交改动及其 diff；未提交内容也是扫描基线的一部分。数据库的源码归档可用于核对扫描时内容。扫描尚未完成、失败或缺失某个目标时，不得用其他提交的旧报告补成完整结果。

## 维护与验证

维护查询时保留 `tests/fixtures/cases.ts` 内正例、反例和 `tests/check.mjs` 的真实 SARIF 断言。修改路径或提取设置后用 CLI 重跑 fixture 和整仓扫描，确认隐藏的 `.agents/skills/` 路径仍被实际提取；改查询时还需检查受影响的真实源码，不能只靠 fixture。`tests/tool-io-mutants.patch` 仅属于历史实验，若使用，先核对其旧上游基线且只应用在独立副本。

不要引入永久 suppression、候选状态库、手写调用图或以候选数量为门槛的 gate。SARIF 是扫描产物；最终报告由 agent 审查代码后直接回答。只有用户要求保存时才另建报告文件。

仓库扫描由 scan.sh 显式把仓库根与本 skill 目录列为 `LGTM_INDEX_INCLUDE`。JavaScript 提取器默认跳过隐藏子目录，单独扫描 fixture 成功并不证明整仓扫描包含它；实现依据见 [官方 AutoBuild 源码](https://github.com/github/codeql/blob/main/javascript/extractor/src/com/semmle/js/extractor/AutoBuild.java)。对其他目标不添加仓库 skill 路径。
