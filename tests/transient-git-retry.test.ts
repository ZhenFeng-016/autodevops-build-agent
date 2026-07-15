import assert from 'node:assert/strict';
import test from 'node:test';
import { repoInstallScript, repoSyncScript } from '../apps/agent/src/adapters/ssh.js';
import { isTransientGitFailure, withTransientGitRetry } from '../apps/agent/src/transient-git-retry.js';

test('transient Git transport failures retry with bounded backoff', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await withTransientGitRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('Connection closed by 121.40.26.88 port 22');
    return 'ok';
  }, {
    sleepFn: async (ms) => { delays.push(ms); },
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2_000, 5_000]);
});

test('permanent Git authentication failures are not retried', async () => {
  let attempts = 0;
  await assert.rejects(() => withTransientGitRetry(async () => {
    attempts += 1;
    throw new Error('git@gitea.51mars.com: Permission denied (publickey).');
  }, {
    sleepFn: async () => undefined,
  }), /Permission denied/);

  assert.equal(attempts, 1);
  assert.equal(isTransientGitFailure('Host key verification failed.'), false);
  assert.equal(isTransientGitFailure('fetch-pack: unexpected disconnect while reading sideband packet'), true);
});

test('remote repository delivery retries sync and package-manager Git transport failures', () => {
  const syncScript = repoSyncScript('git@gitea.example.test:Oak-Team/oak-domain.git', 'dev', '/opt/autodevops/workspaces/project');
  const installScript = repoInstallScript('/opt/autodevops/workspaces/project');

  assert.match(syncScript, /run_with_git_retry git clone/);
  assert.match(syncScript, /run_with_git_retry git fetch/);
  assert.match(installScript, /run_with_git_retry pnpm install/);
  assert.match(installScript, /run_with_git_retry yarn install/);
  assert.match(installScript, /run_with_git_retry "\$@"/);
});
