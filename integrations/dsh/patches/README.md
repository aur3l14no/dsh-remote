# Downstream DSH patches

`series.json` pins the upstream revision and ordered, SHA-256 checked patches. The first patch changes only `@deepseek-ai/dsh-api-session-controller`: three existing source files and one new contract module. It does not change Agent loop, Session JSONL, subprocess or filesystem packages.

## 0001: Session admission

The original controller creates a local directory before preset setup and resumes cold Agents without preparing their execution environment. An external provider alone cannot intercept those steps. The patch adds an optional awaited `apiSessionAdmission.prepare` contract, exports its types, and passes explicit workspace/source identities through creation and fork.

Every create caller is admitted before sharing in-flight work; resume and live/raced adoption validate authority. Admission failures cannot be bypassed by raced-Agent fallback. When the provider owns directory preparation, the controller skips local mkdir. Without the provider, native local directory and Session behavior remain in place. The contract contains no SSH/helper or portable_workspace business logic.

The source-only adapter in ../plugins/session-admission implements remote policy. The patched-host gate covers direct creation/adoption, concurrent conflicting selections, cold/observed/lookup activation, fork, revoked admission, missing or unavailable Worlds, and local create/resume regression. It is not full browser, upload transport, Linux/SSH or model acceptance.

Run from the repository root:

```sh
node integrations/dsh/scripts/check-patched-host.mjs "$DSH_SOURCE"
DSH_TEST_RG="$LOCAL_RG" node target/patched-host/admission.mjs
```

The gate exports a clean pinned checkout into target/patched-host/source, applies the series and checks affected host/integration types before bundling. Original unchanged-source gates retain their revision and cleanliness checks and still reproduce the unpatched gaps. Never edit the user's upstream checkout or vendor its full tree into this directory.

New candidates can be passed by patch filename as the build command's last argument. Add them to the series only after behavior acceptance. An upstream upgrade must reapply and retest the series before updating the supported revision.
