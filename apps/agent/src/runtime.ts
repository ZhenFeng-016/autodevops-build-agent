import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import type { ClaimedJob } from '@zhenfengxx/contracts';
import { errorMessage, isJobExecutionCancelled, JobExecutionCancelledError, sleep } from './common.js';
import { AGENT_CAPABILITIES, ControlPlaneClient } from './api-client.js';
import { SystemCodexAdapter } from './adapters/codex.js';
import { SystemGitAdapter } from './adapters/git.js';
import { SystemJenkinsAdapter } from './adapters/jenkins.js';
import { SshRemoteAdapter } from './adapters/ssh.js';
import type { AgentConfig } from './config.js';
import { executeJob, type ExecutorDependencies } from './executors/index.js';
import { protocolIdentity } from './identity.js';
import { ReadinessService } from './readiness.js';
import { AGENT_FEATURES, targetSshIdentity } from './target-ssh-identity.js';

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
        const claim = await this.client.claimJob(this.config.leaseSeconds);
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
        features: [...AGENT_FEATURES],
        targetSsh: targetSshIdentity(this.config),
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
        features: [...AGENT_FEATURES],
        targetSsh: targetSshIdentity(this.config),
      },
      ...identity,
    });
  }

  async executeClaim(claim: ClaimedJob) {
    const { job, attempt, leaseToken } = claim;
    const execution = new AbortController();
    const monitor = this.monitorExecution(claim, execution);
    this.logger(`claimed ${job.id} ${job.type}`);
    try {
      await this.client.event(job.id, {
        agentId: this.config.agentId,
        attemptId: attempt.id,
        type: 'agent.started',
        status: 'running',
        message: `Agent ${this.config.agentId} started ${job.type}`,
      });
      const resultSummary = await executeJob(job, this.executors, { signal: execution.signal });
      if (execution.signal.aborted) throw new JobExecutionCancelledError(cancellationReason(execution.signal));
      await this.client.complete(job.id, {
        agentId: this.config.agentId,
        attemptId: attempt.id,
        agentWorkspacePath: typeof resultSummary.workspacePath === 'string' ? resultSummary.workspacePath : undefined,
        resultSummary,
      });
      this.logger(`completed ${job.id}`);
    } catch (error) {
      const message = errorMessage(error);
      if (isJobExecutionCancelled(error) || execution.signal.aborted) {
        await this.client.acknowledgeJobCancellation(job.id, attempt.id, leaseToken, message)
          .catch((ackError) => this.logger(`failed to acknowledge job cancellation: ${errorMessage(ackError)}`));
        this.logger(`cancelled ${job.id}: ${message}`);
        return;
      }
      await this.client.fail(job.id, {
        agentId: this.config.agentId,
        attemptId: attempt.id,
        errorSummary: message,
      }).catch((failError) => this.logger(`failed to report job failure: ${errorMessage(failError)}`));
      this.logger(`failed ${job.id}: ${message}`);
    } finally {
      monitor.stop();
      await monitor.done;
    }
  }

  private monitorExecution(claim: ClaimedJob, execution: AbortController) {
    const stopped = new AbortController();
    let leaseExpiresAt = Date.parse(claim.leaseExpiresAt);
    const done = (async () => {
      while (!stopped.signal.aborted && !execution.signal.aborted) {
        try {
          await sleep(this.config.executionControlIntervalMs, stopped.signal);
        } catch {
          return;
        }
        try {
          const control = await this.client.controlJobExecution(claim.job.id, claim.attempt.id, claim.leaseToken);
          if (control.action === 'cancel') {
            execution.abort(control.reason ?? `Job entered ${control.jobStatus}`);
            return;
          }
          if (control.leaseExpiresAt) leaseExpiresAt = Date.parse(control.leaseExpiresAt);
        } catch (error) {
          const message = errorMessage(error);
          if (/failed \(404\)/.test(message)) {
            this.logger('execution control endpoint is unavailable; continuing in protocol v1 compatibility mode');
            return;
          }
          this.logger(`execution control check failed: ${message}`);
          if (!Number.isFinite(leaseExpiresAt) || Date.now() >= leaseExpiresAt) {
            execution.abort('Execution lease expired while the control plane was unreachable');
            return;
          }
        }
      }
    })();
    return {
      done,
      stop: () => stopped.abort(),
    };
  }
}

function cancellationReason(signal: AbortSignal) {
  return typeof signal.reason === 'string' ? signal.reason : 'Job execution was cancelled';
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
