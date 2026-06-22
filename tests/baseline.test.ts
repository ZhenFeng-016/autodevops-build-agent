import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { createWorkerSignature, verifyWorkerSignature } from '@zhenfengxx/agent-sdk';

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
