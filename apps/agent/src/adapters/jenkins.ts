import { JenkinsClient } from '@autodevops/integrations';
import type { JenkinsParameterDefinition } from '@autodevops/integrations';

export type JenkinsRunInput = {
  baseUrl?: string;
  username?: string;
  apiToken?: string;
  jobName: string;
  jenkinsfile?: string;
  parameters: Record<string, string>;
  parameterDefinitions: JenkinsParameterDefinition[];
  signal?: AbortSignal;
};

export interface JenkinsAdapter {
  run(input: JenkinsRunInput): Promise<{ configured: boolean; queueUrl?: string }>;
}

export class SystemJenkinsAdapter implements JenkinsAdapter {
  async run(input: JenkinsRunInput) {
    if (!input.baseUrl) return { configured: false };
    const client = new JenkinsClient({ baseUrl: input.baseUrl.replace(/\/+$/, ''), username: input.username, apiToken: input.apiToken, signal: input.signal });
    if (input.jenkinsfile) await client.upsertPipelineJob(input.jobName, input.jenkinsfile, input.parameterDefinitions);
    const queue = await client.triggerBuild(input.jobName, input.parameters);
    return { configured: true, queueUrl: queue.queueUrl };
  }
}
