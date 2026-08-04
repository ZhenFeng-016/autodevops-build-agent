import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldIsolateOakDependencyScripts } from '../apps/agent/src/adapters/git.js';
import { remoteCommandArgs, repoInstallScript, repoSyncScript } from '../apps/agent/src/adapters/ssh.js';
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

test('command timeouts are not retried as transient Git failures', async () => {
  let attempts = 0;
  await assert.rejects(() => withTransientGitRetry(async () => {
    attempts += 1;
    throw Object.assign(new Error('connection timed out'), { timedOut: true });
  }, {
    sleepFn: async () => undefined,
  }), /connection timed out/);

  assert.equal(attempts, 1);
});

test('remote repository delivery retries sync and package-manager Git transport failures', () => {
  const syncScript = repoSyncScript('git@gitea.example.test:Oak-Team/oak-domain.git', 'dev', '/opt/autodevops/workspaces/project');
  const installScript = repoInstallScript('/opt/autodevops/workspaces/project');

  assert.match(syncScript, /run_with_git_retry git clone/);
  assert.match(syncScript, /run_with_git_retry git fetch/);
  assert.match(syncScript, /refs\/remotes\/origin\/\$branch/);
  assert.match(syncScript, /git checkout --detach "\$commit"/);
  assert.match(syncScript, /synced_commit:%s/);
  const preCheckoutReset = syncScript.indexOf('git reset --hard HEAD');
  const preCheckoutClean = syncScript.indexOf('git clean -fd', preCheckoutReset);
  const checkout = syncScript.indexOf('git checkout --detach "$commit"');
  assert.ok(preCheckoutReset > -1, 'managed workspaces discard tracked generator changes before checkout');
  assert.ok(preCheckoutClean > preCheckoutReset, 'managed workspaces remove untracked checkout conflicts');
  assert.ok(checkout > preCheckoutClean, 'workspace reconciliation happens before checkout');
  assert.doesNotMatch(syncScript, /git checkout "\$ref"/);
  assert.doesNotMatch(syncScript, /git reset --hard "\$ref"/);
  assert.match(installScript, /run_with_git_retry pnpm install/);
  assert.match(installScript, /run_with_git_retry yarn install/);
  assert.match(installScript, /run_with_git_retry "\$@"/);
  assert.match(installScript, /--legacy-peer-deps --ignore-scripts/);
  assert.match(installScript, /npm run postinstall --if-present/);
});

test('Oak applications with a Git-installed CLI isolate dependency lifecycle scripts', () => {
  assert.equal(shouldIsolateOakDependencyScripts({
    oak: { package: true },
    devDependencies: { '@xuchangzju/oak-cli': 'git+ssh://git@gitea.example.test/Oak-Team/oak-cli.git#dev' },
  }), true);
  assert.equal(shouldIsolateOakDependencyScripts({
    oak: { package: true },
    devDependencies: { '@xuchangzju/oak-cli': 'file:../oak-cli' },
  }), false);
  assert.equal(shouldIsolateOakDependencyScripts({
    devDependencies: { '@xuchangzju/oak-cli': 'git+ssh://git@gitea.example.test/Oak-Team/oak-cli.git#dev' },
  }), false);
});

test('remote commands enforce the requested timeout on the target host process group', () => {
  assert.deepEqual(remoteCommandArgs(60 * 60 * 1_000), [
    'timeout',
    '--signal=TERM',
    '--kill-after=15s',
    '3600s',
    'bash',
    '-s',
  ]);
});
