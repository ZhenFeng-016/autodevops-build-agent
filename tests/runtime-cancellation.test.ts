import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClaimedJob, Project } from '@zhenfengxx/contracts';
import { JobExecutionCancelledError } from '../apps/agent/src/common.js';
import type { AgentConfig } from '../apps/agent/src/config.js';
import type { ExecutorDependencies } from '../apps/agent/src/executors/index.js';
import { AgentRuntime } from '../apps/agent/src/runtime.js';

test('AgentRuntime interrupts a running executor and acknowledges cancellation without reporting failure', async () => {
  const calls = { control: 0, acknowledge: 0, complete: 0, fail: 0 };
  const client = {
    event: async () => ({}),
    controlJobExecution: async () => {
      calls.control += 1;
      return { action: 'cancel' as const, jobStatus: 'cancelling', reason: 'operator requested cancellation' };
    },
    acknowledgeJobCancellation: async () => { calls.acknowledge += 1; },
    complete: async () => { calls.complete += 1; },
    fail: async () => { calls.fail += 1; },
  };
  const config: AgentConfig = {
    apiBaseUrl: 'https://control.example.test',
    workspaceRoot: '/tmp/autodevops-runtime-cancellation',
    agentId: 'agent-1',
    agentName: 'agent-1',
    serverId: 'build-1',
    pollIntervalMs: 1,
    leaseSeconds: 60,
    executionControlIntervalMs: 5,
    runOnce: true,
    codexCli: 'codex',
    serviceManager: 'pm2',
  };
  const project: Project = {
    id: 'project-1', name: 'project-1', repositoryUrl: 'git@example.test/project-1.git', defaultBranch: 'main', developmentBranch: 'main',
    productionBranch: 'main', environment: 'test', automationMode: 'deploy', databaseInitMode: 'skip',
  };
  const executors: ExecutorDependencies = {
    config,
    git: {
      syncWorkspace: async () => config.workspaceRoot,
      installDependencies: async () => ({}),
      checkoutBranch: async () => undefined,
      commitAndPushFix: async () => ({}),
      mergeAndPush: async () => 'commit',
      head: async () => 'commit',
    },
    remote: {
      isLocal: () => false,
      targetPath: () => '/opt/autodevops/workspaces/project-1',
      syncProject: async (_project, _server, _gitRef, _install, _timeoutMs, signal) => new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new JobExecutionCancelledError(String(signal.reason))), { once: true });
      }),
      cleanupRuntime: async () => ({ code: 0, stdout: '', stderr: '' }),
      testConnection: async () => ({ code: 0, stdout: '', stderr: '' }),
      probeRuntimeConfig: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
    codex: { run: async () => ({ stdout: '{}', stderr: '' }) },
    jenkins: { run: async () => ({ configured: false }) },
    readiness: { build: async () => ({ ready: true, status: 'ready', checks: [] }) },
    getProject: async () => project,
  };
  const claim: ClaimedJob = {
    job: {
      id: 'job-1', type: 'repo.sync', status: 'running', targetProjectId: project.id, requiredCapabilities: ['repo.sync'], priority: 100,
      params: { project, gitRef: 'main', targetServer: { id: 'runtime-1', name: 'runtime-1', role: 'build' } },
    },
    attempt: { id: 'attempt-1', jobId: 'job-1', agentId: 'agent-1', attemptNumber: 1, status: 'running' },
    leaseToken: 'lease-token-1',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const runtime = new AgentRuntime(config, client as never, {} as never, executors, () => undefined);

  await runtime.executeClaim(claim);

  assert.equal(calls.control, 1);
  assert.equal(calls.acknowledge, 1);
  assert.equal(calls.complete, 0);
  assert.equal(calls.fail, 0);
});
