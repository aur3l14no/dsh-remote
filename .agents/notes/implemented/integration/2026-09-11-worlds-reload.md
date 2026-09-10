# Worlds configuration reload

Status: implemented

## Decision and scope

User approved a change notification followed by a read-only dry run dialog and explicit apply. The installed Web profile checks worlds.json every two seconds; manual Reload worlds also checks local skill source changes. No skill source watcher or new model-side host execution authority is introduced. All product changes remain in integrations/dsh/; the upstream patch series and generic runtime are unchanged.

A preview snapshots local source contents, validates catalog identities and shared-target selections, checks prerequisites and managed remote versions, and reports World/Workspace changes plus skill and file/directory add/update/remove differences. Remote preview does not create files. Lists are bounded to the control transport output budget with full counts retained. A single host preview expires after ten minutes; cancellation, replacement and disposal remove local staging.

Apply rechecks the configuration and every remote content/mode fingerprint before writes, then checks again under the shared per-target deployment lock. It uses prepared bytes even if the local source changes. Unchanged skills are not uploaded. Removal unlinks only an extension-owned skill symlink, retaining immutable versions. Cross-target application is not transactional: results include failures/skipped items, publication keeps the prior catalog on partial failure, and automatic skill sync pauses until another reviewed apply completes. Preview/progress/recovery state is process-local; startup still reads worlds.json normally.

Retired Worlds remain displayable for saved Sessions. Definition resolution uses immutable saved rows when the catalog entry is absent; new-session entry points require a present catalog World. Reusing an existing World ID with another target is rejected. Legacy skill selections are a fallback only when the new declaration omits enabledSkills; an old explicit selection must not override a newly edited declaration.

## Evidence

Baseline: DSH 0.1.5-rc.1, upstream 183f08e9c6dde7e36cd2318eaee70b0da08fb35e, extension 0.3.2. Local dirty development build, not a published release.

Passed:

- check-web-plugin.mjs host/client types and build-extension.mjs (19 existing compatibility packages).
- Nine client navigation / skill lifetime tests; git diff --check.
- e2e.mjs -- node tests/e2e/worlds-reload.mjs: two real Linux/SSH Worlds, no-write preview/cancel, frozen source bytes, stale config and remote state rejection, managed-version drift, special filenames/empty directories, file add/update/remove counts, managed unlink, foreign destination conflict, partial failure and retry.
- e2e.mjs -- node tests/e2e/connect-install.mjs: official CLI install and Chromium; automatic change prompt, expanded file diff, cancel/apply, stale approval, target-change refusal, World retirement, old Session remote file read after host restart, binding preservation, runtime download/retry and offline cache, sidebar pin/archive/navigation regression. Screenshot: artifacts/dsh/worlds-reload-preview.png; result: artifacts/dsh/connect-install.json.
- Full web-e2e.mjs two-World regression passed before the final file-diff display addition; the final file-diff implementation was then covered by both focused SSH and installed-browser gates above. Existing result: artifacts/dsh/result.json. No new live-model or GitHub runner claim.

## Local deployment

Installed the final artifact through the official CLI into the existing Web profile and restarted its launchd service. Compared all 532 installed files against the tested tarball with no mismatches. The final tarball SHA-256 prefix is 95eabd29f5e24623. The previous extension and an immutable copy of the final package are retained in the private deployment backups directory; no production worlds/config/binding contents were edited by this task.

Re-adding a mutable same-version tarball path with pnpm 11.22.0 reused old files, including with --force. Installing the identical bytes under a content-addressed filename resolved the stale package. Future local redeploys should likewise verify installed bytes and use an immutable package path. Historical acceptance files and existing unrelated lockfiles remain intact.
