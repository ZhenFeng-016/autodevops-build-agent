import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const version = process.argv.find((argument) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(argument));
const npmCli = process.env.npm_execpath;
if (!version) throw new Error('Usage: npm run release:verify -- <version>');
if (!npmCli) throw new Error('npm_execpath is required; run through npm run release:verify');

const names = [
  '@zhenfengxx/contracts',
  '@zhenfengxx/agent-sdk',
  '@zhenfengxx/repo-inspector',
  '@zhenfengxx/build-agent',
];
const directory = mkdtempSync(join(tmpdir(), 'autodevops-published-release-'));

try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'autodevops-release-verification', private: true, type: 'module' }));
  execFileSync(process.execPath, [
    npmCli,
    'install',
    '--ignore-scripts',
    '--registry=https://registry.npmjs.org',
    ...names.map((name) => `${name}@${version}`),
  ], { cwd: directory, stdio: 'inherit' });

  for (const name of names) {
    const manifest = JSON.parse(readFileSync(resolve(directory, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
    assert.equal(manifest.version, version, `${name} installed an unexpected version`);
  }

  const contracts = await import(pathToFileURL(resolve(directory, 'node_modules/@zhenfengxx/contracts/dist/index.js')).href);
  const sdk = await import(pathToFileURL(resolve(directory, 'node_modules/@zhenfengxx/agent-sdk/dist/index.js')).href);
  const inspector = await import(pathToFileURL(resolve(directory, 'node_modules/@zhenfengxx/repo-inspector/dist/index.js')).href);
  assert.equal(contracts.PROTOCOL_VERSION, 1);
  assert.equal(contracts.AgentClaimRequestSchema.parse({ protocolVersion: 1 }).protocolVersion, 1);
  assert.equal(typeof sdk.AgentClient, 'function');
  assert.equal(typeof inspector.inspectRepository, 'function');

  const cli = resolve(directory, 'node_modules/@zhenfengxx/build-agent/dist/cli.js');
  const versionOutput = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim();
  assert.match(versionOutput, new RegExp(`^autodevops-agent ${version.replace(/\./g, '\\.')}\\+[a-f0-9]{12}$`));
  console.log(`Published release ${version} verified from npmjs in ${names.length} clean-installed packages`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
