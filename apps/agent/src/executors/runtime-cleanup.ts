import type { Job } from '@zhenfengxx/contracts';
import { requireProject, requireTargetServer } from '../common.js';
import type { RuntimeCleanupSpec } from '../adapters/ssh.js';
import type { ExecutorDependencies } from './types.js';

export async function executeRuntimeCleanup(job: Job, dependencies: ExecutorDependencies) {
  const project = requireProject(job.params.project);
  const targetServer = requireTargetServer(job.params.targetServer);
  const cleanup = cleanupSpec(job.params.cleanup);
  const timeoutMs = Number(job.params.timeoutMs ?? 180_000);
  const result = await dependencies.remote.cleanupRuntime(project, targetServer, cleanup, timeoutMs);
  if (result.code !== 0) throw new Error(`Runtime cleanup failed on ${targetServer.name}: ${result.stderr || result.stdout}`);
  return {
    status: 'success',
    summary: `Remote cleanup completed on ${targetServer.name}.`,
    targetServerId: targetServer.id,
    paths: cleanup.paths ?? [],
    aliasPaths: cleanup.aliasPaths ?? [],
    pm2AppName: cleanup.pm2AppName,
    dockerContainerName: cleanup.dockerContainerName,
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-4000),
  };
}

function cleanupSpec(value: unknown): RuntimeCleanupSpec {
  if (!value || typeof value !== 'object') throw new Error('cleanup is required in job params');
  const raw = value as RuntimeCleanupSpec;
  return {
    paths: Array.isArray(raw.paths) ? raw.paths.map((item) => String(item ?? '').trim()).filter(Boolean) : [],
    aliasPaths: Array.isArray(raw.aliasPaths)
      ? raw.aliasPaths.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const alias = item as { path?: unknown; target?: unknown };
          const path = String(alias.path ?? '').trim();
          const target = String(alias.target ?? '').trim();
          return path && target ? [{ path, target }] : [];
        })
      : [],
    allowedPrefixes: Array.isArray(raw.allowedPrefixes) ? raw.allowedPrefixes.map((item) => String(item ?? '').trim()).filter(Boolean) : undefined,
    stopRuntime: raw.stopRuntime === true,
    pm2AppName: optionalString(raw.pm2AppName),
    dockerContainerName: optionalString(raw.dockerContainerName),
  };
}

function optionalString(value: unknown) {
  const text = String(value ?? '').trim();
  return text || undefined;
}
