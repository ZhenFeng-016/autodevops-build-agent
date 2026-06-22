import './load-env.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { newEntityId } from './runtime-utils.js';
import { truthy } from './common.js';

export type AgentConfig = {
  apiBaseUrl: string;
  workspaceRoot: string;
  agentId: string;
  agentName: string;
  serverId?: string;
  pollIntervalMs: number;
  runOnce: boolean;
  authSecret?: string;
  authToken?: string;
  codexCli: string;
  gitSshKeyPath?: string;
  serviceManager: string;
};

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const workspaceRoot = resolve(env.AUTODEVOPS_AGENT_WORKSPACE_ROOT || join(process.cwd(), '.autodevops', 'agent-workspaces'));
  const config: AgentConfig = {
    apiBaseUrl: (env.AUTODEVOPS_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, ''),
    workspaceRoot,
    agentId: env.AUTODEVOPS_AGENT_ID || loadPersistentAgentId(workspaceRoot),
    agentName: env.AUTODEVOPS_AGENT_NAME || hostname(),
    serverId: env.AUTODEVOPS_AGENT_SERVER_ID,
    pollIntervalMs: Number(env.AUTODEVOPS_AGENT_POLL_INTERVAL_MS ?? '10000'),
    runOnce: truthy(env.AUTODEVOPS_AGENT_RUN_ONCE),
    authSecret: env.AUTODEVOPS_AGENT_AUTH_SECRET,
    authToken: env.AUTODEVOPS_AGENT_AUTH_TOKEN,
    codexCli: env.CODEX_CLI || 'codex',
    gitSshKeyPath: env.AUTODEVOPS_GIT_SSH_KEY_PATH,
    serviceManager: env.AUTODEVOPS_AGENT_SERVICE_MANAGER ?? 'pm2',
  };
  configureGitSshCommand(config.gitSshKeyPath);
  return config;
}

export function generatePm2Config(config: AgentConfig, executable = process.argv[1]) {
  return {
    apps: [
      {
        name: `autodevops-agent-${config.agentId}`,
        script: executable,
        interpreter: process.execPath,
        cwd: process.cwd(),
        autorestart: true,
        restart_delay: 5000,
        max_restarts: 20,
        env: {
          NODE_ENV: 'production',
          AUTODEVOPS_API_URL: config.apiBaseUrl,
          AUTODEVOPS_AGENT_ID: config.agentId,
          AUTODEVOPS_AGENT_NAME: config.agentName,
          AUTODEVOPS_AGENT_WORKSPACE_ROOT: config.workspaceRoot,
          ...(config.serverId ? { AUTODEVOPS_AGENT_SERVER_ID: config.serverId } : {}),
        },
      },
    ],
  };
}

function loadPersistentAgentId(workspaceRoot: string) {
  const stateDir = resolve(workspaceRoot, '..');
  const stateFile = join(stateDir, '.autodevops-agent-id');
  mkdirSync(stateDir, { recursive: true });
  if (existsSync(stateFile)) {
    const existing = readFileSync(stateFile, 'utf8').trim();
    if (existing) return existing;
  }
  const id = newEntityId();
  writeFileSync(stateFile, `${id}\n`, { encoding: 'utf8' });
  return id;
}

function configureGitSshCommand(keyPath?: string) {
  if (!keyPath || !existsSync(keyPath)) return;
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Some filesystems ignore POSIX modes.
  }
  process.env.GIT_SSH_COMMAND = `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
}
