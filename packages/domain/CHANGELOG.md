# @zhenfengxx/contracts

## 1.4.0

### Minor Changes

- e434c1b: Detect platform-managed Oak PostgreSQL, MySQL, and Redis runtime configuration requirements, advertise runtime-config capabilities, and submit Jenkins parameters in the POST body so sensitive values do not enter URLs.

## 1.3.0

### Minor Changes

- a3f84dd: Add BuildAgent-to-runtime SSH association tests with a dedicated target-host key separate from repository Git credentials.
- a3f84dd: Detect platform-managed Oak PostgreSQL, MySQL, and Redis runtime configuration requirements, advertise runtime-config capabilities, and submit Jenkins parameters in the POST body so sensitive values do not enter URLs.

## 1.2.1

### Patch Changes

- 35fe727: Add the `runtime.cleanup` job type and BuildAgent executor for safe remote project cleanup.

## 1.2.0

## 1.1.1

### Patch Changes

- 2509eb5: Declare the MIT license for every public package and include the repository license in published artifacts.

## 1.1.0

### Minor Changes

- f3d3fee: Introduce the runtime-validated protocol v1, explicit Agent version and capability
  negotiation, typed job lifecycle requests, and strict package boundaries between
  contracts, repository inspection, and BuildAgent runtime logic.
