# SSH approval and rooted file publication

Status: implemented

## Contract

Remote retains DSH's native permission service, presets and approval requests. Bound SSH model calls use an approval gate scoped to the remote preset. Full access bypasses the gate; reads are allowed. In workspace-write, canonical workspace-contained write/edit operations bypass approval only when the helper advertises `fs.rooted-publish`. Other restricted operations require `allowed-once`; rejection, cancellation, unavailable approval and permission changes prevent execution. The `never` policy prevents required approvals, without blocking operations already permitted by the gate.

The generic Linux helper accepts optional `fs.beginWrite.writeRoot`. Canonical containment checks and retained parent/staging directory descriptors protect publication from path replacement. This is a directory capability for one upload, not an OS sandbox or confinement of arbitrary processes. Commands and approved outside-workspace writes use SSH account permissions. Model context includes World identity and enforcement facts; human approval reasons summarize the operation and location.

The independent `ssh-approval.e2e.ts` lane uses native approval events and deterministic model tool calls, with no third-party plugin dependency. Current contracts are in `docs/system-map.md` and `docs/reference/helper-api.md`.

## Acceptance

Baseline: DSH `0.1.5-rc.1`, revision `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`; helper `0.1.4`.

- `npm run check` and `npm test` passed, including native Rust checks, 44 Node tests (2 skipped), unchanged-source, patched-host and browser type gates.
- `npm run test-integration` and 12 packaging/client checks passed before the rooted-file refinement; they do not independently establish its Linux behavior.
- Linux x86_64 helper build and rooted publication regression passed in the Docker builder image. Checks include sibling-prefix, dot-dot and symlink escapes, parent replacement during upload and nested creation.
- Real Linux/SSH file operations passed: in-workspace write/edit/read without approval; outside write/edit allow/reject; cancelled/unavailable requests; permission changes during approval; Full access bypass.
- Native human approval rejection caused no write. Actual screenshots were personally inspected at 1365×900 and 390×900 in light/dark themes after layout transitions completed.
- Local extension and private bootstrap manifest were updated after profile/config backup. No commit, push or public release.

Private evidence: `.build/dsh/rooted-check.log`, `.build/dsh/rooted-tests.log`, `.build/dsh/rooted-linux-tests.log`, `.build/dsh/rooted-e2e-ui-final.log`, `.build/dsh/approval-packaging-final.log`, `.build/dsh/rooted-deployment.json`, and `.build/dsh/rooted-approval-{1365,390}-{light,dark}.png`. These historical runs predate extraction of the self-contained approval lane. Its current report is `artifacts/dsh/ssh-approval-result.json`; the audit run log is `.build/dsh/ssh-approval-audit.log`.
