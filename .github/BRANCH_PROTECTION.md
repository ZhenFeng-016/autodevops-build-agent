# Required main-branch rules

Configure a GitHub ruleset for `main` after the repository is created:

- Require pull requests and at least one approving review.
- Dismiss stale approvals when new commits are pushed.
- Require the `CI / verify` status check.
- Require branches to be up to date before merging.
- Block force pushes and branch deletion.
- Allow the Changesets version workflow to create pull requests; it must not bypass required CI.

The `npm` environment must restrict deployment to `main`. Each public npm package must trust `ZhenFeng-016/autodevops-build-agent`, workflow `publish-npm-packages.yml`, environment `npm`, and only the `npm publish` action.
