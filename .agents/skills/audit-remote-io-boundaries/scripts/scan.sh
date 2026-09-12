#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo 'Usage: scan.sh SOURCE_ROOT WORK_DIRECTORY REPORT_DIRECTORY' >&2
  exit 2
fi
skill=$(cd "$(dirname "$0")/.." && pwd)
pack="$skill/codeql"
repo=$(cd "$skill/../../.." && pwd)
source_root=$(cd "$1" && pwd)
work=$2
report=$3
codeql=${CODEQL:-codeql}
cache=${CODEQL_COMMON_CACHES:-"$repo/.build/dsh/codeql-cache"}
mkdir -p "$work" "$report"

# The JS extractor skips hidden subdirectories unless they are explicit roots.
if [ "$source_root" = "$repo" ]; then
  export LGTM_INDEX_INCLUDE
  LGTM_INDEX_INCLUDE=$(printf '%s\n%s' "$source_root" "$skill")
fi

# Dependencies are installed separately with `codeql pack ci`; targets are not built.
"$codeql" database create "$work/database" --language=javascript --build-mode=none \
  --source-root="$source_root" --codescanning-config="$pack/extraction.yml" \
  --threads="${CODEQL_THREADS:-2}" --ram="${CODEQL_RAM:-4096}" --common-caches="$cache" 2>&1 | tee "$work/extraction.log"
"$codeql" database analyze "$work/database" "$pack/queries" \
  --format=sarif-latest --output="$report/results.sarif" \
  --threads="${CODEQL_THREADS:-2}" --ram="${CODEQL_RAM:-4096}" --common-caches="$cache"
