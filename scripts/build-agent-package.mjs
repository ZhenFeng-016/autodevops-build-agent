import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageRoot = join(root, 'apps', 'agent');
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const revision = process.env.AUTODEVOPS_BUILD_REVISION ?? resolveGitRevision();
const outdir = join(packageRoot, 'dist');

function resolveGitRevision() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '000000000000';
  }
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: [join(packageRoot, 'src', 'cli.ts')],
  outfile: join(outdir, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __AUTODEVOPS_AGENT_VERSION__: JSON.stringify(packageJson.version),
    __AUTODEVOPS_AGENT_REVISION__: JSON.stringify(revision),
  },
});
chmodSync(join(outdir, 'cli.js'), 0o755);
console.log(`BuildAgent package ready: ${packageJson.version}+${revision}`);
