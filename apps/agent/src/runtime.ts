import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import type { ClaimedJob } from '@zhenfengxx/contracts';
import { errorMessage, sleep } from './common.js';
import { AGENT_CAPABILITIES, ControlPlaneClient } from './api-client.js';
import { SystemCodexAdapter } from './adapters/codex.js';
import { SystemGitAdapter } from './adapters/git.js';
import { SystemJenkinsAdapter } from './adapters/jenkins.js';
import { SshRemoteAdapter } from './adapters/ssh.js';
import type { AgentConfig } from './config.js';
import { executeJob, type ExecutorDependencies } from './executors/index.js';
import { protocolIdentity } from './identity.js';
import { ReadinessService } from './readiness.js';

export class AgentRuntime {
  constructor(
    private readonly config: AgentConfig,
    private readonly client: ControlPlaneClient,
    private readonly readiness: ReadinessService,
    private readonly executors: ExecutorDependencies,
    private readonly logger: (message: string) => void = defaultLogger,
  ) {}

  async run() {
    mkdirSync(this.config.workspaceRoot, { recursive: true });
    await this.register();
    while (true) {
      try {
        await this.heartbeat();
        const claim = await this.client.claimJob();
        if ('claimed' in claim && claim.claimed === false) {
          if (this.config.runOnce) break;
          await sleep(this.config.pollIntervalMs);
          continue;
        }
        await this.executeClaim(claim as ClaimedJob);
      } catch (error) {
        this.logger(`agent loop error: ${errorMessage(error)}`);
        if (this.config.runOnce) throw error;
        await sleep(this.config.pollIntervalMs);
      }
      if (this.config.runOnce) break;
    }
  }

  async register() {
    const readiness = await this.readiness.build();
    const identity = await protocolIdentity();
    await this.client.register({
      id: this.config.agentId,
      name: this.config.agentName,
      status: readiness.ready ? 'online' : 'degraded',
      serverId: this.config.serverId,
      endpoint: `local://${hostname()}`,
      capabilities: [...AGENT_CAPABILITIES],
      readiness,
      runtimeStatus: await this.readiness.runtimeStatus(),
      metadata: {
        workspaceRoot: this.config.workspaceRoot,
        hostname: hostname(),
        codexHome: process.env.CODEX_HOME,
        serviceManager: this.config.serviceManager,
      },
      ...identity,
    });
    this.logger(`registered ${this.config.agentId}`);
  }

  async heartbeat() {
    const readiness = await this.readiness.build();
    const identity = await protocolIdentity();
    await this.client.heartbeat({
      status: readiness.ready ? 'online' : 'degraded',
      serverId: this.config.serverId,
      capabilities: [...AGENT_CAPABILITIES],
      readiness,
      runtimeStatus: await this.readiness.runtimeStatus(),
      metadata: {
        workspaceRoot: this.config.workspaceRoot,
        hostname: hostname(),
        codexSkills: await this.readiness.codexSkills(),
      },
      ...identity,
    });
  }

  async executeClaim(claim: ClaimedJob) {
    const { job, attempt } = claim;
    this.logger(`claimed ${job.id} ${job.type}`);
    try {
      await this.client.event(job.id, {
        agentId: this.config.agentId,
        attemptId: attempt.id,
        type: 'agent.started',
        status: 'running',
        message: `Agent ${this.config.agentId} started ${job.type}`,
      });
      const resultSummary = await executeJob(job, this.executors);
      await this.client.complete(job.id, {
        agentId: this.config.agentId,
        attemptId: attempt.id,
        agentWorkspacePath: typeof resultSummary.workspacePath === 'string' ? resultSummary.workspacePath : undefined,
        resultSummary,
      });
      this.logger(`completed ${job.id}`);
    } catch (error) {
      const message = errorMessage(error);
      await this.client.fail(job.id, {
        agentId: this.config.agentId,
        attemptId: attempt.id,
        errorSummary: message,
      }).catch((failError) => this.logger(`failed to report job failure: ${errorMessage(failError)}`));
      this.logger(`failed ${job.id}: ${message}`);
    }
  }
}

export function createSystemRuntime(config: AgentConfig) {
  const client = new ControlPlaneClient(config);
  const readiness = new ReadinessService(config);
  const git = new SystemGitAdapter(config);
  const dependencies: ExecutorDependencies = {
    config,
    git,
    remote: new SshRemoteAdapter(config),
    codex: new SystemCodexAdapter(config.codexCli),
    jenkins: new SystemJenkinsAdapter(),
    readiness,
    getProject: (projectId) => client.project(projectId),
  };
  return new AgentRuntime(config, client, readiness, dependencies);
}

function defaultLogger(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
