import type { Job } from '@zhenfengxx/contracts';
import type { TargetServer } from '../common.js';
import type { ExecutorDependencies } from './types.js';

export async function executeServerSshTest(job: Job, dependencies: ExecutorDependencies) {
  const targetServer = job.params.targetServer as TargetServer | undefined;
  if (!targetServer?.id || !targetServer.name) throw new Error('server.ssh.test requires targetServer');
  const timeoutMs = Number(job.params.timeoutMs ?? 30_000);
  const result = await dependencies.remote.testConnection(targetServer, timeoutMs);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || `ssh exited ${result.code}`).trim();
    throw new Error(`SSH from BuildAgent to ${targetServer.name} failed: ${detail}`);
  }
  return {
    status: 'success',
    sourceServerId: dependencies.config.serverId,
    targetServerId: targetServer.id,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: result.code,
  };
}
