# @zhenfengxx/build-agent

## 1.2.1

### Patch Changes

- 35fe727: Prepare local `file:` package dependencies recursively before installing an application workspace.
- 35fe727: Retry transient Git and SSH transport failures during repository synchronization and dependency installation without retrying permanent authentication failures.
- 35fe727: Add the `runtime.cleanup` job type and BuildAgent executor for safe remote project cleanup.
- 35fe727: Expose ID-based project checkouts through safe project-name workspace aliases so sibling `file:../package` dependencies resolve on build agents.

## 1.2.0

### Minor Changes

- 89a0321: Split the BuildAgent into CLI, runtime, API client, readiness, injected system
  adapters and per-domain job executors. Add protocol identity output, safe PM2
  configuration, diagnostics and a clean-Linux npm installation smoke test.

## 1.1.1

### Patch Changes

- 2509eb5: Declare the MIT license for every public package and include the repository license in published artifacts.

## 1.1.0

### Minor Changes

- f3d3fee: Introduce the runtime-validated protocol v1, explicit Agent version and capability
  negotiation, typed job lifecycle requests, and strict package boundaries between
  contracts, repository inspection, and BuildAgent runtime logic.
