import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFileWithProcessTree } from '../apps/agent/src/process-execution.js';

test('timed out commands terminate their descendant process tree', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'autodevops-process-tree-'));
  const marker = join(workspace, 'descendant-survived.txt');
  const descendantScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 800)`;
  const parentScript = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;

  await assert.rejects(
    () => execFileWithProcessTree(process.execPath, ['-e', parentScript], { timeout: 100 }),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { timedOut?: unknown }).timedOut === true),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(existsSync(marker), false);
});
