# Downstream DSH patches

`series.json` pins the upstream revision and ordered, SHA-256 checked patches. The first patch changes only `@deepseek-ai/dsh-api-session-controller`: three existing source files and one new contract module. It does not change Agent loop, Session JSONL, subprocess or filesystem packages.

The current series contains six patches across nine native packages:

| Patch | Native seam |
| --- | --- |
| 0001 | Session admission before create/resume/fork |
| 0002 | Optional Workspace feed for an external registry |
| 0003 | Optional Bash workdir resolver |
| 0004 | Provider-based cwd resolution in file tools |
| 0005 | Session-aware skill lookup/cache and Agent instruction environment |
| 0006 | Session-owned media URLs, remote canonical file links, and Agent filesystem/root for workspace previews and change feeds |

`0005` retains native parsing, invocation controls and instruction projection. Local defaults remain when no environment provider is mounted; remote profiles disable completed-catalog caching because they have no remote watcher. Its four catalog test assertion updates reflect the added identity/signal arguments. Run the patched-host and browser gates in [development](../../../docs/development.md).

## 0001: Session admission

The original controller creates a local directory before preset setup and resumes cold Agents without preparing their execution environment. An external provider alone cannot intercept those steps. The patch adds an optional awaited `apiSessionAdmission.prepare` contract, exports its types, and passes explicit workspace/source identities through creation and fork.

Every create caller is admitted before sharing in-flight work; resume and live/raced adoption validate authority. Admission failures cannot be bypassed by raced-Agent fallback. When the provider owns directory preparation, the controller skips local mkdir. Without the provider, native local directory and Session behavior remain in place. The contract contains no SSH/helper or portable_workspace business logic.

The extension adapter in ../packages/workspace/portable-workspace/src/admission.ts implements remote policy. The patched-host gate covers direct creation/adoption, concurrent conflicting selections, cold/observed/lookup activation, fork, revoked admission, missing or unavailable Worlds, and local create/resume regression. It is not full browser, upload transport, Linux/SSH or model acceptance.

Build/run commands are maintained in [development](../../../docs/development.md#上游兼容检查升级或补丁变更).

The gate exports a clean pinned checkout into .build/dsh/patched-host/source, applies the series and checks affected host/integration types before bundling. Original unchanged-source gates retain their revision and cleanliness checks and still reproduce the unpatched gaps. Never edit the user's upstream checkout or vendor its full tree into this directory.

New candidates can be passed by patch filename as the build command's last argument. Add them to the series only after behavior acceptance. An upstream upgrade must reapply and retest the series before updating the supported revision.


## 0006: File previews

The official workspace-files controller reads the host FS and takes its root from sandbox policy. The media route has only an absolute path. The patch supplies optional environment seams; our plugin selects the committed World, while the Chat browser module carries the rendering Session in image URLs and resolves file links through that Session before constructing resource addresses. This avoids both cross-World collisions and URL normalization of `..` before remote filesystem resolution.

The patch adds two packages to the compatibility set: workspace-files and ui-chat. Session-controller was already patched. The Chat client is rebuilt as an official-identity module factory; the static Web frontend stays official. Source client types and installed browser behavior have separate gates. Preview root containment does not restrict the SSH account's shell permissions or the image endpoint's account-readable absolute paths.
