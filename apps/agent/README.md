# @zhenfengxx/build-agent

Build-plane worker for AutoDevOps repository inspection, synchronization, Jenkins orchestration, and Codex jobs.

```bash
npm install -g @zhenfengxx/build-agent
autodevops-agent
autodevops-agent version --json
autodevops-agent diagnose
autodevops-agent pm2-config
```

Requires Node.js 20 or newer and an AutoDevOps control-plane URL and agent credential in the environment.

The default command starts the worker. `diagnose` reports readiness and version
identity without registering the agent. `pm2-config` emits a complete PM2 app
definition containing only non-secret identity and location values; credentials
remain in the host-managed environment.

The runtime is composed from independent API, readiness, Git, SSH, Codex,
Jenkins, and job-executor modules. System adapters are injected at startup so
all supported job types can be contract-tested without invoking real external
systems.
