#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'Usage: install-cli.sh VERSION INSTALL_DIRECTORY (Linux x64)' >&2
  exit 2
fi
version=$1
mkdir -p "$2"
cd "$2"
gh release download "$version" --repo github/codeql-cli-binaries \
  --pattern codeql-linux64.zip --pattern codeql-linux64.zip.checksum.txt --dir .
sha256sum -c codeql-linux64.zip.checksum.txt
unzip -q codeql-linux64.zip
rm codeql-linux64.zip
