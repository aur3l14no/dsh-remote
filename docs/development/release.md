# 发行

发行单位是一个完整归档：官方 DSH 对应的扩展 tarball、目标平台 helper/ripgrep、`release.json`和许可证。官方 DSH 和 npm 依赖仍按官方安装机制准备。模型凭据、World 地址、binding 和测试日志不进入归档。源码模块保持统一发行，不要求用户分别安装 World、workspace 和 skill 模块。

仓库使用 CI 验收候选，再手动触发 GitHub Actions 发布；执行结果以相应 revision 的 Actions 为准。无需发布 npm。发行目标为 **Linux x86_64 / aarch64（静态 musl）** 与 **macOS aarch64（Darwin）**。宿主按安装文档要求准备官方 DSH、Node 和 OpenSSH。

## 产物与验证

CI 在三个原生 runner 上构建 helper、校验固定版本与摘要的 ripgrep，并运行对应二进制的协议与 bootstrap 验收。Linux 产物检查静态链接，避免目标依赖 glibc。Linux x86_64 的同一份静态产物还用于官方 CLI 安装、真实 SSH 与浏览器验收；macOS 与 Linux ARM64 的原生运行时验收不代替这条 DSH 整合验收。

全部检查通过后，`assemble-runtime-release.mjs` 核对三个平台的源码身份与组件版本，合并 manifest 和内容寻址产物，再由 `pack-release.mjs` 生成完整归档。自动下载使用 `dsh-remote-runtime.tar.gz`，远端探测结果决定选用哪一对 helper/ripgrep；同一宿主缓存可服务不同平台的 World。

`release.json` 记录仓库 revision、源码是否有未提交改动、上游 revision、DSH/扩展版本、扩展摘要和 runtime 平台清单。只复制清单声明的内容寻址产物，不打包整个开发 cache。bootstrap 仍会核对远端平台与产物摘要，不在宿主执行目标二进制。

三平台产物准备好后，组装完整候选（输出目录必须不存在）：

```sh
node integrations/dsh/scripts/assemble-runtime-release.mjs \
  dist/dsh/extension-build.json .build/runtime/platforms .build/dsh/release-candidate
```

单平台开发验收也可从显式产物组装：

```sh
node integrations/dsh/scripts/pack-release.mjs \
  dist/dsh/extension-build.json /absolute/manifest.json \
  /absolute/cache /absolute/ripgrep-license .build/dsh/release-candidate
```

该命令只证明组装与摘要一致，不证明平台标签正确或已通过运行验收。平台标签由产物准备者负责；公开草稿只接受下述成功 CI 来源。

## GitHub Release

1. 在 main 上完成 CI，取得成功 run ID。该次 CI 必须产出 `dsh-remote-release-<source SHA>` artifact，且仍在保留期内。
2. 手动运行 **Release** workflow，填入 `ci_run`；勾选 `publish` 正式发布，不勾选则只创建草稿。它只接受 main 的成功 push/workflow_dispatch run，拒绝 PR、源码 SHA 不符、dirty 产物和错误目标平台。
3. 工作流下载已验收归档，校验清单，将其中的扩展逐字节复制为固定附件名 `dsh-remote-extension.tgz`，连同三平台 runtime 归档创建 `v<extensionVersion>` 草稿。包内版本保留，不重新构建。版本来自 `build-extension.mjs`，此通道只接受 `x.y.z`；新发行前先更新版本。
4. `publish` 开启时，工作流将草稿发布为正式 Release，并设为 latest；否则保留草稿供检查。这样 README 的 `releases/latest/download/dsh-remote-extension.tgz` 才会指向它。草稿与预发布不会成为 latest，无需发布 npm。

各个 tag 的附件保持独立；固定的是附件文件名，不是版本 tag。不要重写旧版本附件，已有版本需要修正时发布新版本。

本地测试不会触发发布；新增工作流也不会自行运行。候选文件保留 14 天。安装命令见 [README](../../README.md)，维护与配置初始化见 [开发与验证](README.md)，上游升级门槛见 [上游升级参考](upstream-upgrades.md)。
