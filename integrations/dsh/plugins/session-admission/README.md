# Remote Session admission

Source-only adapter for the `apiSessionAdmission` interface added by patch 0001. It uses `ssh-world` and the experimental portable_workspace registry; it is not included in the published SSH plugin tarball or a runnable Web profile.

Mount the World owner, portable_workspace registry and this adapter before exposing the patched Session controller. The adapter rejects missing context; it does not infer a World from cwd or grant local-shell access.

- Create: require an explicit portable_workspace, or an existing saved binding and membership. Reject an unbound historical/live identity. Validate the catalog and directory, then persist the binding before Agent creation.
- Resume/adopt: require the saved binding and matching portable_workspace; validate before preparing or returning the Agent.
- Fork: use the source Session binding and matching workspace, then bind the new Session before creation. This does not create a Git worktree.

A failed Agent setup may leave a durable binding. Retrying the same selection is permitted; redirecting it is not. A missing membership after failed attachment requires explicit workspace selection to repair attachment. Connection failure follows the existing World owner's failure policy; admission does not replace a failed runtime or replay commands.

The patch retains local mkdir and ordinary Session behavior when no admission adapter is installed. A remote profile must not expose its controller before this adapter is active. Full profile lifecycle, browser transport, uploads, consumer routing and SSH acceptance remain separate gates.
