# @zhenfengxx/build-agent

## 1.5.0

### Minor Changes

- 0fc82de: Add protocol v2 cooperative job cancellation, lease renewal during execution, and process-tree termination so cancelled jobs release their Agent without waiting for command timeouts.

## 1.4.0

### Minor Changes

- e434c1b: Detect platform-managed Oak PostgreSQL, MySQL, and Redis runtime configuration requirements, advertise runtime-config capabilities, and submit Jenkins parameters in the POST body so sensitive values do not enter URLs.

### Patch Changes

- e434c1b: Resolve repository sync, install, Codex fix creation, and fix merge operations from freshly fetched remote commits, and report the exact commit SHA used by repository jobs.

## 1.3.0

### Minor Changes

- a3f84dd: Add BuildAgent-to-runtime SSH association tests with a dedicated target-host key separate from repository Git credentials.
- a3f84dd: Detect platform-managed Oak PostgreSQL, MySQL, and Redis runtime configuration requirements, advertise runtime-config capabilities, and submit Jenkins parameters in the POST body so sensitive values do not enter URLs.

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
