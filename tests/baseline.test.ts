import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { AgentClient, createWorkerSignature, verifyWorkerSignature } from '@zhenfengxx/agent-sdk';
import {
  AgentClaimRequestSchema,
  AgentRegistrationRequestSchema,
  JobParamsEnvelopeSchema,
  PROTOCOL_VERSION,
  negotiateProtocol,
} from '@zhenfengxx/contracts';

test('Agent SDK HMAC signatures remain deterministic and timestamp guarded', () => {
  const input = { method: 'POST', path: '/jobs/1/complete', timestamp: '1700000000', rawBody: '{"ok":true}', secret: 'test-secret' };
  const signature = createWorkerSignature(input);
  assert.equal(signature, createWorkerSignature(input));
  assert.equal(verifyWorkerSignature({ ...input, signature, nowMs: 1_700_000_000_000 }), true);
  assert.equal(verifyWorkerSignature({ ...input, signature, nowMs: 1_700_001_000_000 }), false);
});

test('packaged BuildAgent reports a versioned executable', () => {
  const output = execFileSync(process.execPath, ['apps/agent/dist/cli.js', '--version'], { encoding: 'utf8' }).trim();
  assert.match(output, /^autodevops-agent 1\.0\.1\+[a-f0-9]{12}$/);
});

test('protocol v1 validates registration and negotiates capabilities', () => {
  const registration = AgentRegistrationRequestSchema.parse({
    id: 'agent-1',
    name: 'agent-1',
    status: 'online',
    capabilities: ['repo.inspect', 'repo.sync'],
    readiness: { ready: true, status: 'ready', checks: [] },
    agentVersion: '1.1.0',
    buildRevision: '123456789abc',
    protocolVersion: PROTOCOL_VERSION as 1,
    supportedProtocolVersions: [PROTOCOL_VERSION],
  });
  const negotiation = negotiateProtocol(registration);
  assert.equal(negotiation.compatible, true);
  assert.deepEqual(negotiation.capabilities, ['repo.inspect', 'repo.sync']);
  assert.throws(() => AgentClaimRequestSchema.parse({ protocolVersion: 2 }));
});

test('protocol v1 validates typed job parameters at runtime', () => {
  const parsed = JobParamsEnvelopeSchema.parse({
    type: 'repo.inspect',
    params: {
      project: { id: 'token-api', repositoryUrl: 'git@example.test/token-api.git', defaultBranch: 'main' },
      gitRef: 'main',
      generateRuntimeContract: true,
    },
  });
  assert.equal(parsed.type, 'repo.inspect');
  assert.throws(() => JobParamsEnvelopeSchema.parse({ type: 'repo.sync', params: {} }));
});

test('Agent SDK executes the authenticated register, heartbeat, claim, lease, event, complete and fail contract', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  const responses = [
    { id: 'agent-1', name: 'agent-1', status: 'online', capabilities: [] },
    { id: 'agent-1', name: 'agent-1', status: 'online', capabilities: [] },
    {
      job: { id: 'job-1', type: 'repo.inspect', status: 'running', requiredCapabilities: ['repo.inspect'], params: {}, priority: 100 },
      attempt: { id: 'attempt-1', jobId: 'job-1', agentId: 'agent-1', attemptNumber: 1, status: 'running' },
      leaseToken: 'lease-1',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    { id: 'event-1', jobId: 'job-1', type: 'agent.started' },
    { ok: true },
    { ok: true },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const identity = {
    agentVersion: '1.1.0',
    buildRevision: '123456789abc',
    protocolVersion: PROTOCOL_VERSION as 1,
    supportedProtocolVersions: [PROTOCOL_VERSION],
  };
  const readiness = { ready: true, status: 'ready' as const, checks: [] };
  const client = new AgentClient('https://control.example.test', { agentId: 'agent-1', secret: 'contract-secret' }, fetchImpl);

  await client.register({ id: 'agent-1', name: 'agent-1', status: 'online', capabilities: ['repo.inspect'], readiness, ...identity });
  await client.heartbeat({ status: 'online', capabilities: ['repo.inspect'], readiness, ...identity });
  const claim = await client.claimJob({ protocolVersion: PROTOCOL_VERSION, capabilities: ['repo.inspect'], leaseSeconds: 60 });
  assert.equal('leaseToken' in claim ? claim.leaseToken : undefined, 'lease-1');
  await client.appendEvent('job-1', { agentId: 'agent-1', attemptId: 'attempt-1', type: 'agent.started' });
  await client.completeJob('job-1', { agentId: 'agent-1', attemptId: 'attempt-1', resultSummary: { ok: true } });
  await client.failJob('job-1', { agentId: 'agent-1', attemptId: 'attempt-1', errorSummary: 'contract failure' });

  assert.deepEqual(requests.map((request) => request.path), [
    '/build-agents/register',
    '/build-agents/agent-1/heartbeat',
    '/build-agents/agent-1/claim-job',
    '/jobs/job-1/events',
    '/jobs/job-1/complete',
    '/jobs/job-1/fail',
  ]);
  for (const request of requests) {
    assert.equal(request.headers.get('x-agent-id'), 'agent-1');
    assert.match(request.headers.get('x-agent-signature') ?? '', /^[a-f0-9]{64}$/);
  }
});
