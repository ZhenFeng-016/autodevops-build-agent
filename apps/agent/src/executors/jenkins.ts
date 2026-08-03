import type { Job } from '@zhenfengxx/contracts';
import type { JenkinsParameterDefinition } from '@autodevops/integrations';
import { requireProject, required, stringValue } from '../common.js';
import type { ExecutorDependencies, JobExecutionContext } from './types.js';

export async function executeJenkinsRun(job: Job, dependencies: ExecutorDependencies, context: JobExecutionContext) {
  const definition = job.params.definition as { jenkinsJobName?: string; jenkinsfile?: string } | undefined;
  const project = requireProject(job.params.project);
  const jenkins = job.params.jenkins && typeof job.params.jenkins === 'object' ? job.params.jenkins as Record<string, unknown> : {};
  const baseUrl = stringValue(jenkins.baseUrl) || process.env.JENKINS_BASE_URL || '';
  const parameters = {
    PIPELINE_RUN_ID: stringValue(job.params.pipelineRunId),
    PROJECT_ID: project.id,
    GIT_REF: stringValue(job.params.gitRef) || project.productionBranch || project.defaultBranch,
    COMMIT_SHA: stringValue(job.params.commitSha),
    ENVIRONMENT: stringValue(job.params.environment) || project.environment,
    DEPLOY_MODE: stringValue(job.params.deployMode),
    GIT_URL: project.repositoryUrl,
    HEALTH_URL: stringValue(job.params.healthUrl),
    PRODUCTION_SSH: stringValue(job.params.productionSsh),
    MIGRATION_APPROVAL_TOKEN: stringValue(job.params.migrationApprovalToken),
    DATA_INIT_APPROVAL_TOKEN: stringValue(job.params.dataInitApprovalToken),
    RUNTIME_CONFIG_LEASE_ID: stringValue(job.params.runtimeConfigLeaseId),
    RUNTIME_CONFIG_TOKEN: stringValue(job.params.runtimeConfigToken),
  };
  const result = await dependencies.jenkins.run({
    baseUrl,
    username: stringValue(jenkins.username) || process.env.JENKINS_USERNAME || process.env.JENKINS_USER,
    apiToken: stringValue(jenkins.apiToken) || process.env.JENKINS_API_TOKEN || process.env.JENKINS_TOKEN,
    jobName: required(definition?.jenkinsJobName, 'jenkinsJobName'),
    jenkinsfile: definition?.jenkinsfile,
    parameters,
    parameterDefinitions: jenkinsParameterDefinitions(job.params.jenkinsParameterDefinitions, Object.keys(parameters)),
    signal: context.signal,
  });
  if (!result.configured) {
    return { status: 'warning', summary: 'Jenkins is not configured on this build agent; pipeline run remains queued.', jenkinsConfigured: false };
  }
  return { status: 'success', summary: 'Jenkins pipeline triggered by build agent.', jenkinsConfigured: true, jenkinsQueueUrl: result.queueUrl };
}

function jenkinsParameterDefinitions(value: unknown, parameterNames: string[]): JenkinsParameterDefinition[] {
  if (Array.isArray(value)) {
    const configured = value.map((item) => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const type = stringValue(row.type);
      return {
        name: stringValue(row.name),
        type: type === 'password' || type === 'boolean' ? type : 'string',
        description: stringValue(row.description) || undefined,
      } satisfies JenkinsParameterDefinition;
    });
    const configuredNames = new Set(configured.map((item) => item.name));
    const missing = parameterNames.filter((name) => !configuredNames.has(name));
    if (missing.length) throw new Error(`Jenkins parameter definitions are incomplete; missing: ${missing.join(', ')}`);
    return configured;
  }
  return parameterNames.map((name) => ({
    name,
    type: /(?:TOKEN|PASSWORD|SECRET)$/.test(name) ? 'password' : 'string',
    description: 'Managed by AutoDevOps',
  }));
}
