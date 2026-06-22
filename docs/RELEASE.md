# Release runbook

This runbook is the release authority for the four public `@zhenfengxx`
packages in this repository. A release is incomplete until every required
check and external setting below has been verified against current state.

## Repository controls

- The repository is public so GitHub Free enforces branch protection.
- `main` requires a pull request, the `verify` GitHub Actions check, an
  up-to-date branch, resolved review conversations, and linear history.
- Administrators cannot bypass the rule. Force pushes and branch deletion are
  disabled.
- The GitHub environment is named `npm`, does not permit administrator bypass,
  and accepts deployments from protected branches only.
- GitHub Actions is permitted to create version pull requests. No npm token is
  stored as an Actions or environment secret.

## npm Trusted Publishers

Configure every package with the same publisher identity:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `ZhenFeng-016` |
| Repository | `autodevops-build-agent` |
| Workflow filename | `publish-npm-packages.yml` |
| Environment name | `npm` |
| Allowed action | npm publish |

The packages are:

- `@zhenfengxx/contracts`
- `@zhenfengxx/agent-sdk`
- `@zhenfengxx/repo-inspector`
- `@zhenfengxx/build-agent`

Password, 2FA, recovery codes, and npm tokens must never be copied into source,
command arguments, workflow files, repository secrets, or logs.

## Release sequence

1. Add a Changeset for every publishable change and open a pull request.
2. Merge only after `verify` passes and the branch is current.
3. Merge the Changesets-generated version pull request after its checks pass.
4. Dispatch `Publish npm packages` from `main`. The workflow must obtain npm
   credentials through GitHub OIDC and publish to the `next` tag.
5. In a clean directory, verify the exact published version:

   ```bash
   npm run release:verify -- <version>
   ```

6. Complete compatibility and real-host deployment gates through M7 before
   promoting the same version:

   ```bash
   npm run release:promote -- <version> --check
   npm run release:promote -- <version>
   ```

The promotion step is intentionally interactive and local because npm dist-tag
mutation is not covered by Trusted Publishing. It checks that all four `next`
tags point to the requested version before changing any `latest` tag.

## Failure handling

- If CI fails, fix the branch and rerun it; never bypass `verify`.
- If OIDC publication fails, verify all five Trusted Publisher fields and the
  GitHub environment restriction. Do not add a broad npm token as a shortcut.
- If only part of the fixed release publishes, do not promote. Correct the
  publisher binding, rerun the idempotent workflow, and then clean-install all
  four packages.
- If clean installation or compatibility fails, keep `latest` unchanged and
  publish a corrected patch to `next`.
