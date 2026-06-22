# AutoDevOps BuildAgent

Independent source repository for the public AutoDevOps Agent packages:

- `@zhenfengxx/contracts`
- `@zhenfengxx/agent-sdk`
- `@zhenfengxx/repo-inspector`
- `@zhenfengxx/build-agent`

The repository owns the Agent protocol, authenticated API client, repository/runtime inspection, and the executable build-plane worker. The AutoDevOps control plane consumes released package versions and must not import this repository's source tree.

## Local verification

```bash
npm ci
npm run ci
```

## Versioning and release

Every user-visible package change requires a Changeset. Merging the generated version PR updates package versions and changelogs. The manual `Publish npm packages` workflow publishes the already-versioned packages to the `next` tag through npm Trusted Publishing/OIDC.

After clean-install and compatibility verification, check and promote the exact
same version from a locally authenticated terminal. Authentication remains
interactive and is never passed as a command argument:

```bash
npm run release:verify -- 1.1.0
npm run release:promote -- 1.1.0 --check
npm run release:promote -- 1.1.0
```

The promotion command refuses to proceed unless all four `next` tags already
point to the requested, published version. It then verifies every resulting
`latest` tag. This local step is intentional: Trusted Publishing covers package
publication, while tag mutation must not introduce a long-lived npm token into
GitHub Actions.

No npm password, recovery code, automation token, or `.npmrc` credential belongs in this repository or its GitHub settings. A granular automation token is permitted only as an explicitly approved fallback when OIDC is unavailable.
