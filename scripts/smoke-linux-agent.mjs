import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const packDir = mkdtempSync(join(tmpdir(), 'autodevops-agent-linux-smoke-'));
const requests = [];
const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : {} });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/build-agents/register') {
      response.end(JSON.stringify({ id: 'linux-smoke-agent', name: 'linux-smoke-agent', status: 'degraded', capabilities: [] }));
      return;
    }
    if (request.url === '/build-agents/linux-smoke-agent/heartbeat') {
      response.end(JSON.stringify({ id: 'linux-smoke-agent', name: 'linux-smoke-agent', status: 'degraded', capabilities: [] }));
      return;
    }
    if (request.url === '/build-agents/linux-smoke-agent/claim-job') {
      response.end(JSON.stringify({ claimed: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: `Unexpected smoke route: ${request.url}` }));
  });
});

try {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve smoke API port');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is required; run this smoke through npm');
  await execFileAsync(process.execPath, [npmCli, 'pack', '--workspace', '@zhenfengxx/build-agent', '--pack-destination', packDir], {
    cwd: root,
    timeout: 60_000,
  });
  const tarball = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('BuildAgent npm pack did not produce a tarball');
  const tarballPath = join(packDir, tarball);
  const { stdout, stderr } = await execFileAsync('docker', [
    'run', '--rm',
    '--add-host=host.docker.internal:host-gateway',
    '-v', `${tarballPath}:/tmp/build-agent.tgz:ro`,
    '-e', `AUTODEVOPS_API_URL=http://host.docker.internal:${address.port}`,
    '-e', 'AUTODEVOPS_AGENT_ID=linux-smoke-agent',
    '-e', 'AUTODEVOPS_AGENT_NAME=linux-smoke-agent',
    '-e', 'AUTODEVOPS_AGENT_RUN_ONCE=1',
    '-e', 'AUTODEVOPS_AGENT_AUTH_SECRET=linux-smoke-secret',
    'node:24-alpine',
    'sh', '-lc',
    'npm install -g /tmp/build-agent.tgz --ignore-scripts --no-audit --no-fund >/tmp/npm-install.log && autodevops-agent version --json && autodevops-agent',
  ], { cwd: root, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });
  const expectedPaths = [
    '/build-agents/register',
    '/build-agents/linux-smoke-agent/heartbeat',
    '/build-agents/linux-smoke-agent/claim-job',
  ];
  for (const path of expectedPaths) {
    if (!requests.some((request) => request.path === path)) throw new Error(`Linux smoke did not call ${path}`);
  }
  if (!stdout.includes('"protocolVersion": 1')) throw new Error(`Linux smoke version output is missing protocolVersion: ${stdout}`);
  if (!stdout.includes('registered linux-smoke-agent')) throw new Error(`Linux smoke agent did not start: ${stdout}\n${stderr}`);
  console.log(`Linux npm-pack smoke passed in node:24-alpine (${expectedPaths.length} lifecycle calls)`);
} finally {
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(packDir, { recursive: true, force: true });
}
