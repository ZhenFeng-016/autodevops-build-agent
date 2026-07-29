import type { Job, ManagedRuntimeConfigKind } from '@zhenfengxx/contracts';
import type { TargetServer } from '../common.js';
import type { ExecutorDependencies, JobExecutionContext } from './types.js';

const SUPPORTED_KINDS = new Set<ManagedRuntimeConfigKind>(['oak_postgres', 'oak_mysql', 'oak_redis']);

export async function executeRuntimeConfigTest(job: Job, dependencies: ExecutorDependencies, context: JobExecutionContext) {
  const targetServer = job.params.targetServer as TargetServer | undefined;
  const targetPath = String(job.params.targetPath ?? '');
  const kind = job.params.kind as ManagedRuntimeConfigKind | undefined;
  const runtimeConfig = job.params.runtimeConfig as Record<string, unknown> | undefined;
  const configId = String(job.params.configId ?? '');
  const revision = Number(job.params.revision ?? 0);
  if (!targetServer?.id || !targetServer.name) throw new Error('runtime.config.test requires targetServer');
  if (!targetPath || !targetPath.startsWith('/')) throw new Error('runtime.config.test requires an absolute targetPath');
  if (!kind || !SUPPORTED_KINDS.has(kind)) throw new Error('runtime.config.test has an unsupported kind');
  if (!runtimeConfig || Array.isArray(runtimeConfig)) throw new Error('runtime.config.test requires transient runtimeConfig');
  if (!configId || !Number.isInteger(revision) || revision < 1) throw new Error('runtime.config.test requires configId and revision');

  const timeoutMs = Number(job.params.timeoutMs ?? 30_000);
  const result = await dependencies.remote.probeRuntimeConfig(targetServer, targetPath, kind, runtimeConfig, timeoutMs, context.signal);
  if (result.code !== 0) {
    const detail = redactProbeError((result.stderr || result.stdout || `probe exited ${result.code}`).trim(), runtimeConfig);
    throw new Error(`Runtime config probe for ${kind} failed: ${detail}`);
  }
  return {
    status: 'success',
    configId,
    revision,
    kind,
    targetServerId: targetServer.id,
    exitCode: result.code,
  };
}

function redactProbeError(message: string, config: Record<string, unknown>) {
  let sanitized = message.replace(/(password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  for (const [key, value] of Object.entries(config)) {
    if (!/(password|passwd|secret|token)/i.test(key) || typeof value !== 'string' || value.length < 3) continue;
    sanitized = sanitized.split(value).join('[REDACTED]');
  }
  return sanitized.slice(0, 2_000);
}
