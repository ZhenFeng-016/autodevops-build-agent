# Required main-branch rules

Configure a GitHub ruleset for `main` after the repository is created:

- Require pull requests and at least one approving review.
- Dismiss stale approvals when new commits are pushed.
- Require the `CI / verify` status check.
- Require branches to be up to date before merging.
- Block force pushes and branch deletion.
- Allow the Changesets version workflow to create pull requests; it must not bypass required CI.

The `npm` environment must restrict deployment to `main`.

Each public npm package must configure trusted publishers for:

- `ZhenFeng-016/autodevops-build-agent`, workflow `publish-npm-packages.yml`, environment `npm`, allowed action `npm publish`.

Trusted Publishing only covers npm publish flows. Promotion of an already-published version from `next`
to `latest` uses `npm dist-tag add`, so the `npm` GitHub environment must also define
`NPM_PROMOTE_TOKEN` as a granular automation token scoped only to:

- `@zhenfengxx/contracts`
- `@zhenfengxx/agent-sdk`
- `@zhenfengxx/repo-inspector`
- `@zhenfengxx/build-agent`

Do not put npm passwords, 2FA codes, recovery codes, or token values in source, chat, workflow logs, or
command arguments.
