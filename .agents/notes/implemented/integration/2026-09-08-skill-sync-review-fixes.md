# Skill synchronization and review fixes

Status: implemented

User selected automatic pre-helper synchronization plus manual Sync Skills, without helper restart.

- Reconnecting unadmitted client calls observe cancellation and release wait listeners/capacity.
- Control transport cancellation, deadline and output limits escalate SIGTERM to SIGKILL after 500 ms on the isolated local process group. This bounds the local caller; it does not prove arbitrary remote grandchildren stopped.
- DSH host owns configured absolute source paths and serializes sync per target. Sync runs before new helper allocation; failure blocks admission and is retryable. Model tools cannot supply source paths.
- Manual World-level Sync Skills uses the same deployment code without restarting helpers. Same-runtime transport reconnect does not sync. Account-shared home, nontransactional lists, retained revisions and independently managed dependencies remain explicit limits.
- Existing revision validation now rejects file permission drift as well as content drift.

Validation: npm test: 31 passed, 2 environment-selected cases skipped; root and Web plugin source type checks passed. Disposable two-Linux-World SSH deployment regression passed, including permission drift, updates, conflicts and execution. Production DSH CLI + Playwright passed automatic sync, failed preconnection sync blocking bindings and corrected-source retry, manual update with unchanged helper PIDs, and failed manual sync preserving deployed content. No live model credentials were needed or used for these checks.

Current contracts: docs/skills.md, docs/source-install.md, docs/execution-boundaries.md. Public CLI result: target/web-acceptance/source-install.json (ignored build evidence).
