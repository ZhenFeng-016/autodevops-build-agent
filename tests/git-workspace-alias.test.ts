import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localFileDependencyPaths, materializeWorkspaceAlias } from '../apps/agent/src/adapters/git.js';

test('workspace aliases expose id checkouts to sibling file dependencies', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'autodevops-workspace-alias-'));
  const targetPath = join(workspaceRoot, 'project-id');
  mkdirSync(targetPath);

  const aliasPath = materializeWorkspaceAlias(workspaceRoot, 'oak-domain', targetPath);

  assert.equal(lstatSync(aliasPath).isSymbolicLink(), true);
  assert.equal(realpathSync(aliasPath), realpathSync(targetPath));
  assert.equal(materializeWorkspaceAlias(workspaceRoot, 'oak-domain', targetPath), aliasPath);
});

test('workspace aliases reject unsafe names and existing unrelated paths', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'autodevops-workspace-alias-'));
  const targetPath = join(workspaceRoot, 'project-id');
  mkdirSync(targetPath);

  assert.throws(() => materializeWorkspaceAlias(workspaceRoot, '../escape', targetPath), /cannot be used as a workspace alias/);
  mkdirSync(join(workspaceRoot, 'oak-domain'));
  assert.throws(() => materializeWorkspaceAlias(workspaceRoot, 'oak-domain', targetPath), /already exists/);
});

test('local file dependencies resolve through workspace aliases before root installation', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'autodevops-local-dependencies-'));
  const appPath = join(workspaceRoot, 'app-id');
  const dependencyPath = join(workspaceRoot, 'dependency-id');
  mkdirSync(appPath);
  mkdirSync(dependencyPath);
  writeFileSync(join(dependencyPath, 'package.json'), JSON.stringify({ name: 'oak-domain' }));
  writeFileSync(join(appPath, 'package.json'), JSON.stringify({
    dependencies: { 'oak-domain': 'file:../oak-domain', remote: '^1.0.0' },
  }));
  symlinkSync(dependencyPath, join(workspaceRoot, 'oak-domain'), process.platform === 'win32' ? 'junction' : 'dir');

  assert.deepEqual(localFileDependencyPaths(appPath, workspaceRoot), [realpathSync(dependencyPath)]);
});

test('local file dependencies cannot escape the agent workspace', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'autodevops-local-dependencies-'));
  const appPath = join(workspaceRoot, 'app-id');
  const outsidePath = mkdtempSync(join(tmpdir(), 'autodevops-outside-dependency-'));
  mkdirSync(appPath);
  writeFileSync(join(outsidePath, 'package.json'), JSON.stringify({ name: 'outside' }));
  writeFileSync(join(appPath, 'package.json'), JSON.stringify({ dependencies: { outside: `file:${outsidePath}` } }));

  assert.throws(() => localFileDependencyPaths(appPath, workspaceRoot), /escaped agent workspace/);
});
