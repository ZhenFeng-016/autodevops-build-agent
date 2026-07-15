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

Repository protection, npm Trusted Publisher fields, version PR handling, OIDC
proof, clean-install verification, and recovery procedures are defined in
[`docs/RELEASE.md`](docs/RELEASE.md). The detailed Chinese operator guide is
[`docs/RELEASE.zh-CN.md`](docs/RELEASE.zh-CN.md).

After clean-install and compatibility verification, verify the exact candidate
version before dispatching the protected `Promote npm packages to latest`
workflow:

```bash
npm run release:verify -- <version>
npm run release:promote -- <version> --check
```

The promotion workflow refuses to proceed unless all four `next` tags already
point to the requested, published version. Trusted Publishing covers package
publication; a granular `NPM_PROMOTE_TOKEN`, stored only in the protected `npm`
GitHub environment, is used for `npm dist-tag add`.

No npm password, recovery code, token value, or `.npmrc` credential belongs in
source, command arguments, pull requests, or logs.
