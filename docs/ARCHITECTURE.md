# BuildAgent architecture

`@zhenfengxx/build-agent` is the independent build-plane worker for AutoDevOps.
It depends only on packages shipped from this repository and communicates with
the control plane through the versioned protocol in `@zhenfengxx/contracts`.
It must never import source files from the platform repository.

## Runtime composition

The executable entry point is `apps/agent/src/cli.ts`. The default command
loads host configuration and composes `AgentRuntime` with these modules:

- `api-client.ts`: authenticated registration, heartbeat, claim, lease and job
  completion calls through `@zhenfengxx/agent-sdk`.
- `readiness.ts`: host tool and credential checks used during registration and
  by the observability preflight job.
- `adapters/git.ts`: safe workspace checkout, dependency installation and Git
  branch/commit/merge operations.
- `adapters/ssh.ts`: remote repository synchronization and installation.
- `adapters/jenkins.ts`: Jenkins pipeline execution.
- `adapters/codex.ts`: Codex incident analysis and patch generation.
- `executors/*`: runtime-validated implementations of every protocol-v1 job.
- `runtime.ts`: the register, heartbeat, claim, execute and complete/fail loop.

External systems are represented by interfaces and injected when the runtime
is created. Tests can therefore execute the complete job dispatcher with fake
Git, SSH, Jenkins and Codex adapters, while production uses the system-backed
implementations.

## Supported protocol-v1 jobs

- `repo.inspect`
- `repo.sync`
- `repo.install`
- `jenkins.pipeline.run`
- `codex.incident.analyze`
- `codex.fix.create_patch`
- `codex.fix.merge_to_production`
- `observability.preflight`

Job envelopes and job-specific parameters are validated at runtime before an
executor is called. Unsupported or malformed jobs fail explicitly and are
reported to the control plane.

## CLI contract

```bash
autodevops-agent                         # start the worker
autodevops-agent version --json          # version and protocol identity
autodevops-agent diagnose                # host readiness report
autodevops-agent pm2-config              # secret-free PM2 definition
```

Version output contains `agentVersion`, `buildRevision` and
`protocolVersion`. PM2 output intentionally omits the Agent secret; production
must supply credentials through the host-managed environment.

## Acceptance checks

`npm run ci` is the M2 acceptance gate. In addition to type checking, tests,
package-content checks and credential/dependency audits, it runs
`scripts/smoke-linux-agent.mjs`. The smoke test packs the real npm artifact,
globally installs it in a clean `node:24-alpine` container, starts the CLI and
verifies registration, heartbeat and job claim calls against a temporary
control plane.
