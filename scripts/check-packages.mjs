import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packages = [
  ['@zhenfengxx/contracts', 'packages/domain'],
  ['@zhenfengxx/agent-sdk', 'packages/agent-sdk'],
  ['@zhenfengxx/repo-inspector', 'packages/repo-inspector'],
  ['@zhenfengxx/build-agent', 'apps/agent'],
];
const repositoryUrl = 'git+https://github.com/ZhenFeng-016/autodevops-build-agent.git';
const forbiddenPath = /(^|\/)(?:\.env(?:\.|$)|src\/|coverage\/|node_modules\/)|\.(?:log|pem|key)$/i;
const destination = mkdtempSync(join(tmpdir(), 'autodevops-pack-audit-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required; run this audit through npm run check:packages');

const contractSource = [
  readFileSync('packages/domain/src/index.ts', 'utf8'),
  readFileSync('packages/domain/src/protocol.ts', 'utf8'),
].join('\n');
const forbiddenContractLogic = /(?:node:fs|node:path|Prisma|inspectRepository|createRuntimeContract|applyJenkinsWebhook|summarizeProjectActionJobs)/;
if (forbiddenContractLogic.test(contractSource)) {
  throw new Error('@zhenfengxx/contracts contains control-plane or repository implementation logic');
}

try {
  for (const [name, directory] of packages) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (manifest.repository?.url !== repositoryUrl || manifest.repository?.directory !== directory) {
      throw new Error(`${name} repository metadata does not point to its independent source directory`);
    }
    if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.registry !== 'https://registry.npmjs.org') {
      throw new Error(`${name} is missing the public npmjs publish policy`);
    }
    if (manifest.license !== 'MIT') {
      throw new Error(`${name} must declare the MIT license`);
    }
    const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '-w', name, '--json', '--pack-destination', destination], { encoding: 'utf8' }))[0];
    if (!packed?.files?.length || !packed.files.some((entry) => entry.path.startsWith('dist/'))) {
      throw new Error(`${name} pack output is missing dist files`);
    }
    if (!packed.files.some((entry) => entry.path === 'LICENSE')) {
      throw new Error(`${name} pack output is missing LICENSE`);
    }
    const forbidden = packed.files.map((entry) => entry.path).filter((path) => forbiddenPath.test(path));
    if (forbidden.length) throw new Error(`${name} contains forbidden package files: ${forbidden.join(', ')}`);
    console.log(`${name}@${packed.version}: ${packed.files.length} files, ${packed.size} bytes`);
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}
