import type { Job, Project } from '@zhenfengxx/contracts';
import type { CodexAdapter } from '../adapters/codex.js';
import type { GitAdapter } from '../adapters/git.js';
import type { JenkinsAdapter } from '../adapters/jenkins.js';
import type { RemoteAdapter } from '../adapters/ssh.js';
import type { AgentConfig } from '../config.js';
import type { ReadinessService } from '../readiness.js';

export type ExecutorDependencies = {
  config: AgentConfig;
  git: GitAdapter;
  remote: RemoteAdapter;
  codex: CodexAdapter;
  jenkins: JenkinsAdapter;
  readiness: Pick<ReadinessService, 'build'>;
  getProject(projectId: string): Promise<Project>;
};

export type JobExecutor = (job: Job, dependencies: ExecutorDependencies) => Promise<Record<string, unknown>>;
