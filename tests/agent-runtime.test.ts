import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Job, JobType, Project } from '@zhenfengxx/contracts';
import { SUPPORTED_JOB_TYPES, executeJob, type ExecutorDependencies } from '../apps/agent/src/executors/index.js';

test('all protocol v1 job types execute through injected adapters', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'autodevops-agent-m2-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { start: 'node src/server.js' }, dependencies: { express: 'latest' } }));
  writeFileSync(join(workspace, 'src', 'server.js'), 'console.log("fixture")\n');
  const calls = { codex: 0, checkout: 0, commit: 0, merge: 0, install: 0, remote: 0, jenkins: 0 };
  const project = fixtureProject();
  const dependencies: ExecutorDependencies = {
    config: {
      apiBaseUrl: 'https://control.example.test',
      workspaceRoot: workspace,
      agentId: 'agent-m2',
      agentName: 'agent-m2',
      serverId: 'local-server',
      pollIntervalMs: 1,
      runOnce: true,
      codexCli: 'codex',
      serviceManager: 'pm2',
    },
    git: {
      syncWorkspace: async () => workspace,
      installDependencies: async () => {
        calls.install += 1;
        return { command: 'npm ci --include=dev' };
      },
      checkoutBranch: async () => { calls.checkout += 1; },
      commitAndPushFix: async () => {
        calls.commit += 1;
        return { hasChanges: true, pushed: true, commitSha: 'abc123def456' };
      },
      mergeAndPush: async () => {
        calls.merge += 1;
        return 'def456abc123';
      },
      head: async () => 'def456abc123',
    },
    remote: {
      isLocal: (server) => server.id === 'local-server',
      targetPath: () => '/opt/autodevops/workspaces/fixture',
      syncProject: async () => {
        calls.remote += 1;
        return { code: 0, stdout: 'synced', stderr: '', targetPath: '/opt/autodevops/workspaces/fixture' };
      },
    },
    codex: {
      run: async () => {
        calls.codex += 1;
        return { stdout: '{"status":"success","summary":"adapter result"}', stderr: '' };
      },
    },
    jenkins: {
      run: async () => {
        calls.jenkins += 1;
        return { configured: true, queueUrl: 'https://jenkins.example.test/queue/item/1' };
      },
    },
    readiness: {
      build: async () => ({ ready: true, status: 'ready', checks: [{ name: 'runtime', status: 'pass' }] }),
    },
    getProject: async () => project,
  };

  const results = new Map<JobType, Record<string, unknown>>();
  results.set('repo.inspect', await executeJob(job('repo.inspect', { project, gitRef: 'main', generateRuntimeContract: true }), dependencies));
  results.set('repo.sync', await executeJob(job('repo.sync', { project, gitRef: 'main', targetServer: { id: 'remote-server', name: 'remote', role: 'build' } }), dependencies));
  results.set('repo.install', await executeJob(job('repo.install', { project, gitRef: 'main', targetServer: { id: 'local-server', name: 'local', role: 'build' } }), dependencies));
  results.set('jenkins.pipeline.run', await executeJob(job('jenkins.pipeline.run', {
    project,
    definition: { jenkinsJobName: 'fixture-main', jenkinsfile: 'pipeline { agent any }' },
    jenkins: { baseUrl: 'https://jenkins.example.test' },
  }), dependencies));
  results.set('codex.incident.analyze', await executeJob(job('codex.incident.analyze', { incident: { id: 'incident-1', projectId: project.id } }), dependencies));
  results.set('codex.fix.create_patch', await executeJob(job('codex.fix.create_patch', { incident: { id: 'incident-1', projectId: project.id }, project }), dependencies));
  results.set('codex.fix.merge_to_production', await executeJob(job('codex.fix.merge_to_production', { fix: { projectId: project.id, branchName: 'autodevops/fix/fixture' }, project }), dependencies));
  results.set('observability.preflight', await executeJob(job('observability.preflight', {}), dependencies));

  assert.deepEqual([...results.keys()].sort(), [...SUPPORTED_JOB_TYPES].sort());
  assert.ok(results.get('repo.inspect')?.contract);
  assert.equal(results.get('repo.sync')?.mode, 'ssh');
  assert.equal(results.get('repo.install')?.mode, 'local');
  assert.equal(results.get('jenkins.pipeline.run')?.jenkinsConfigured, true);
  assert.equal((results.get('codex.incident.analyze')?.analysis as { status: string }).status, 'success');
  assert.equal(results.get('codex.fix.create_patch')?.pushed, true);
  assert.equal(results.get('codex.fix.merge_to_production')?.mergeCommitSha, 'def456abc123');
  assert.equal(results.get('observability.preflight')?.status, 'success');
  assert.equal(calls.codex, 3);
  assert.equal(calls.remote, 1);
  assert.equal(calls.install, 1);
  assert.equal(calls.jenkins, 1);
  assert.equal(calls.checkout, 1);
  assert.equal(calls.commit, 1);
  assert.equal(calls.merge, 1);
});

test('packaged CLI emits safe PM2 config and diagnostics', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'autodevops-agent-cli-'));
  const env = {
    ...process.env,
    AUTODEVOPS_AGENT_ID: 'agent-cli-test',
    AUTODEVOPS_AGENT_NAME: 'agent-cli-test',
    AUTODEVOPS_AGENT_WORKSPACE_ROOT: workspace,
    AUTODEVOPS_API_URL: 'https://control.example.test',
    AUTODEVOPS_AGENT_AUTH_SECRET: 'must-not-be-printed',
  };
  const pm2 = execFileSync(process.execPath, ['apps/agent/dist/cli.js', 'pm2-config'], { encoding: 'utf8', env });
  assert.doesNotMatch(pm2, /must-not-be-printed|AUTH_SECRET|AUTH_TOKEN/);
  const parsed = JSON.parse(pm2) as { apps: Array<{ name: string; env: Record<string, string> }> };
  assert.equal(parsed.apps[0]?.name, 'autodevops-agent-agent-cli-test');
  assert.equal(parsed.apps[0]?.env.AUTODEVOPS_API_URL, 'https://control.example.test');

  const diagnostics = execFileSync(process.execPath, ['apps/agent/dist/cli.js', 'diagnose'], { encoding: 'utf8', env });
  const report = JSON.parse(diagnostics) as { version: { protocolVersion: number }; readiness: { status: string } };
  assert.equal(report.version.protocolVersion, 1);
  assert.match(report.readiness.status, /ready|degraded/);
  assert.doesNotMatch(diagnostics, /must-not-be-printed/);
});

function fixtureProject(): Project {
  return {
    id: 'fixture',
    name: 'fixture',
    repositoryUrl: 'git@example.test/fixture.git',
    defaultBranch: 'main',
    developmentBranch: 'main',
    productionBranch: 'main',
    environment: 'prod',
    productionServerPath: '/opt/autodevops/apps/fixture',
    automationMode: 'deploy',
    databaseInitMode: 'skip',
  };
}

function job(type: JobType, params: Record<string, unknown>): Job {
  return {
    id: `job-${type}`,
    type,
    status: 'queued',
    requiredCapabilities: [],
    params,
    priority: 100,
  };
}
