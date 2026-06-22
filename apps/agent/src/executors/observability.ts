import type { Job } from '@zhenfengxx/contracts';
import type { ExecutorDependencies } from './types.js';

export async function executeObservabilityPreflight(_job: Job, dependencies: ExecutorDependencies) {
  const readiness = await dependencies.readiness.build();
  return {
    status: readiness.ready ? 'success' : 'warning',
    summary: readiness.ready ? 'Agent observability preflight passed.' : 'Agent observability preflight found blocking checks.',
    readiness,
  };
}
