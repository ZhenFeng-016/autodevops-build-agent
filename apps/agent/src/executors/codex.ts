import { buildFixApplyPrompt, buildIncidentAnalysisPrompt, codexExecutionFailureResult, parseCodexJsonResult } from '@autodevops/codex-prompts';
import type { Job } from '@zhenfengxx/contracts';
import { requireProject, required, stringValue } from '../common.js';
import { generateCodexFixBranchName } from '../runtime-utils.js';
import type { ExecutorDependencies } from './types.js';

export async function executeIncidentAnalysis(job: Job, dependencies: ExecutorDependencies) {
  const incident = job.params.incident as never;
  const prompt = buildIncidentAnalysisPrompt({ job, incident, evidence: (job.params.evidence as Record<string, unknown>) ?? {} });
  try {
    const result = await dependencies.codex.run({
      prompt,
      workspacePath: dependencies.config.workspaceRoot,
      sandbox: 'read-only',
      timeoutMs: Number(process.env.CODEX_INCIDENT_ANALYSIS_TIMEOUT_MS ?? '120000'),
    });
    return { analysis: parseCodexJsonResult(result.stdout), stderr: result.stderr.slice(-4000) };
  } catch (error) {
    return { analysis: codexExecutionFailureResult('Codex incident analysis could not complete.', error) };
  }
}

export async function executeCodexFix(job: Job, dependencies: ExecutorDependencies) {
  const incident = job.params.incident as never;
  const incidentProjectId = stringValue((job.params.incident as { projectId?: string })?.projectId);
  const project = job.params.project ? requireProject(job.params.project) : await dependencies.getProject(incidentProjectId);
  const baseBranch = stringValue(job.params.baseBranch) || project.productionBranch || project.defaultBranch;
  const targetBranch = stringValue(job.params.targetBranch) || project.productionBranch || project.defaultBranch;
  const workspacePath = await dependencies.git.syncWorkspace(project, baseBranch);
  const branchName = stringValue(job.params.branchName) || generateCodexFixBranchName({
    projectId: project.id,
    incidentId: stringValue(job.incidentId) || job.id,
    fixId: stringValue(job.codexFixId) || job.id,
  });
  await dependencies.git.checkoutBranch(workspacePath, branchName, baseBranch);
  const prompt = buildFixApplyPrompt({ job, incident, workspacePath, branchName, baseBranch, targetBranch });
  try {
    const result = await dependencies.codex.run({
      prompt,
      workspacePath,
      sandbox: 'workspace-write',
      timeoutMs: Number(process.env.CODEX_FIX_TIMEOUT_MS ?? '600000'),
    });
    const parsed = parseCodexJsonResult(result.stdout);
    const commit = await dependencies.git.commitAndPushFix(workspacePath, branchName, incident);
    return {
      ...parsed,
      branchName,
      baseBranch,
      targetBranch,
      commitSha: commit.commitSha,
      pushed: commit.pushed,
      hasChanges: commit.hasChanges,
      workspacePath,
      stderr: result.stderr.slice(-4000),
    };
  } catch (error) {
    return { ...codexExecutionFailureResult('Codex fix job could not complete.', error), branchName, baseBranch, targetBranch, workspacePath };
  }
}

export async function executeCodexFixMerge(job: Job, dependencies: ExecutorDependencies) {
  const fix = job.params.fix as { projectId?: string; branchName?: string; targetBranch?: string; baseBranch?: string } | undefined;
  const project = job.params.project ? requireProject(job.params.project) : await dependencies.getProject(stringValue(fix?.projectId));
  const branchName = required(stringValue(job.params.branchName) || fix?.branchName, 'branchName');
  const targetBranch = stringValue(job.params.targetBranch) || fix?.targetBranch || project.productionBranch || project.defaultBranch;
  const baseBranch = stringValue(job.params.baseBranch) || fix?.baseBranch || targetBranch;
  const workspacePath = await dependencies.git.syncWorkspace(project, targetBranch);
  const mergeCommitSha = await dependencies.git.mergeAndPush(workspacePath, branchName, targetBranch);
  return {
    status: 'success',
    summary: `Merged ${branchName} into ${targetBranch}.`,
    branchName,
    baseBranch,
    targetBranch,
    mergeCommitSha,
    workspacePath,
  };
}
