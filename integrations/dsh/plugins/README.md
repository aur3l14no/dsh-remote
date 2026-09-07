# DSH plugins

`ssh-world/` is implemented. It supplies World ownership, filesystem/subprocess providers, managed executable mapping and Session routing; its public package manifest is maintained in ../packaging/.

Project registry/API/UI, remote project skills and file-reference providers belong here when implemented. Do not create empty packages or copy Agent/Session engines as scaffolding. Project identity, plugin code location and execution location are separate concepts; follow [execution boundaries](../../../docs/execution-boundaries.md).
