import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Project } from '@zhenfengxx/contracts';
import { SystemGitAdapter } from '../apps/agent/src/adapters/git.js';
import type { AgentConfig } from '../apps/agent/src/config.js';

test('workspace sync and fix merge resolve the latest remote commits', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'autodevops-git-freshness-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const author = join(root, 'author');
  const workspaceRoot = join(root, 'workspaces');
  mkdirSync(author, { recursive: true });
  git(root, ['init', '--bare', origin]);
  git(author, ['init']);
  git(author, ['config', 'user.email', 'test@example.local']);
  git(author, ['config', 'user.name', 'Freshness Test']);
  git(author, ['checkout', '-b', 'main']);
  git(author, ['remote', 'add', 'origin', origin]);

  writeFileSync(join(author, 'base.txt'), 'first\n');
  git(author, ['add', 'base.txt']);
  git(author, ['commit', '-m', 'first']);
  git(author, ['push', '-u', 'origin', 'main']);

  const adapter = new SystemGitAdapter(agentConfig(workspaceRoot));
  const project = fixtureProject(origin);
  const workspace = await adapter.syncWorkspace(project, 'main');
  const firstCommit = await adapter.head(workspace);

  writeFileSync(join(author, 'base.txt'), 'second\n');
  git(author, ['commit', '-am', 'second']);
  git(author, ['push', 'origin', 'main']);
  const secondCommit = git(author, ['rev-parse', 'HEAD']);

  await adapter.syncWorkspace(project, 'main');
  assert.notEqual(secondCommit, firstCommit);
  assert.equal(await adapter.head(workspace), secondCommit);
  assert.equal(readFileSync(join(workspace, 'base.txt'), 'utf8').trim(), 'second');
  assert.equal(git(workspace, ['symbolic-ref', '-q', '--short', 'HEAD'], true), '');

  await adapter.checkoutBranch(workspace, 'autodevops/fix/freshness', secondCommit);
  writeFileSync(join(workspace, 'fix.txt'), 'fixed\n');
  const fix = await adapter.commitAndPushFix(workspace, 'autodevops/fix/freshness', { id: 'freshness' });
  assert.equal(fix.pushed, true);

  writeFileSync(join(author, 'base.txt'), 'third\n');
  git(author, ['commit', '-am', 'third']);
  git(author, ['push', 'origin', 'main']);
  const thirdCommit = git(author, ['rev-parse', 'HEAD']);

  const mergeCommit = await adapter.mergeAndPush(workspace, 'autodevops/fix/freshness', 'main');
  assert.equal(git(origin, ['rev-parse', 'refs/heads/main'], false, true), mergeCommit);
  assert.equal(readFileSync(join(workspace, 'base.txt'), 'utf8').trim(), 'third');
  assert.equal(readFileSync(join(workspace, 'fix.txt'), 'utf8').trim(), 'fixed');
  git(workspace, ['merge-base', '--is-ancestor', thirdCommit, mergeCommit]);
});

function git(cwd: string, args: string[], allowFailure = false, gitDir = false) {
  try {
    return execFileSync('git', gitDir ? ['--git-dir', cwd, ...args] : args, {
      cwd: gitDir ? undefined : cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function fixtureProject(repositoryUrl: string): Project {
  return {
    id: 'freshness-project',
    name: 'freshness-project',
    repositoryUrl,
    defaultBranch: 'main',
    developmentBranch: 'main',
    productionBranch: 'main',
    environment: 'prod',
  };
}

function agentConfig(workspaceRoot: string): AgentConfig {
  return {
    apiBaseUrl: 'http://127.0.0.1:3000',
    workspaceRoot,
    agentId: 'freshness-agent',
    agentName: 'freshness-agent',
    pollIntervalMs: 1,
    leaseSeconds: 3_600,
    runOnce: true,
    codexCli: 'codex',
    serviceManager: 'pm2',
  };
}
