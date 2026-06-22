import { JobParamsEnvelopeSchema, type Job, type JobType } from '@zhenfengxx/contracts';
import { executeCodexFix, executeCodexFixMerge, executeIncidentAnalysis } from './codex.js';
import { executeJenkinsRun } from './jenkins.js';
import { executeObservabilityPreflight } from './observability.js';
import { executeRepoInspect, executeRepoInstall, executeRepoSync } from './repo.js';
import type { ExecutorDependencies, JobExecutor } from './types.js';

const EXECUTORS: Record<JobType, JobExecutor> = {
  'repo.inspect': executeRepoInspect,
  'repo.sync': executeRepoSync,
  'repo.install': executeRepoInstall,
  'jenkins.pipeline.run': executeJenkinsRun,
  'codex.incident.analyze': executeIncidentAnalysis,
  'codex.fix.create_patch': executeCodexFix,
  'codex.fix.merge_to_production': executeCodexFixMerge,
  'observability.preflight': executeObservabilityPreflight,
};

export const SUPPORTED_JOB_TYPES = Object.freeze(Object.keys(EXECUTORS) as JobType[]);

export async function executeJob(job: Job, dependencies: ExecutorDependencies) {
  JobParamsEnvelopeSchema.parse({ type: job.type, params: job.params });
  const executor = EXECUTORS[job.type];
  if (!executor) throw new Error(`Unsupported job type: ${job.type}`);
  return executor(job, dependencies);
}

export type { ExecutorDependencies } from './types.js';
