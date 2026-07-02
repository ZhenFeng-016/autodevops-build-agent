import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { materializeWorkspaceAlias } from '../apps/agent/src/adapters/git.js';

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
