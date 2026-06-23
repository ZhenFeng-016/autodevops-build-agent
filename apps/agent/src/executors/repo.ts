import { resolve } from 'node:path';
import { buildCommandInferencePrompt, codexExecutionFailureResult, parseCodexJsonResult } from '@autodevops/codex-prompts';
import type { Job, Project, RuntimeContract } from '@zhenfengxx/contracts';
import { createRuntimeContract, inspectRepository } from '@zhenfengxx/repo-inspector';
import { looksSecret, requireProject, requireTargetServer, stringArray, stringValue } from '../common.js';
import type { ExecutorDependencies } from './types.js';

export async function executeRepoInspect(job: Job, dependencies: ExecutorDependencies) {
  const project = requireProject(job.params.project);
  const gitRef = stringValue(job.params.gitRef) || project.developmentBranch || project.defaultBranch;
  const workspacePath = await dependencies.git.syncWorkspace(project, gitRef);
  const inspection = inspectRepository(project.id, workspacePath);
  const automationMode = project.automationMode ?? 'deploy';
  const commandInference = automationMode === 'fetch_only'
    ? {
        mode: automationMode,
        status: 'skipped',
        summary: 'Fetch-only mode skips Codex command inference.',
        commands: { checkout: ['git fetch --all --tags --prune', `git checkout ${gitRef}`] },
      }
    : await inferRepositoryCommands(job, project, inspection, workspacePath, dependencies);
  const generateRuntimeContract = job.params.generateRuntimeContract !== false;
  const contract = generateRuntimeContract
    ? createRuntimeContract(project, inspection, {
        ...((job.params.overrides as Partial<RuntimeContract>) ?? {}),
        automationMode,
        commandInference,
        database: databaseContractFromInference(project, commandInference),
        environmentConfig: environmentConfigFromInference(commandInference),
      } as Partial<RuntimeContract>)
    : undefined;
  return {
    status: 'success',
    summary: generateRuntimeContract ? 'Repository inspected and runtime contract generated.' : 'Repository inspected.',
    workspacePath,
    inspection,
    automationMode,
    commandInference,
    contract,
    generateRuntimeContract,
  };
}

export async function executeRepoSync(job: Job, dependencies: ExecutorDependencies) {
  return executeRepoDelivery(job, dependencies, false);
}

export async function executeRepoInstall(job: Job, dependencies: ExecutorDependencies) {
  return executeRepoDelivery(job, dependencies, true);
}

async function executeRepoDelivery(job: Job, dependencies: ExecutorDependencies, install: boolean) {
  const project = requireProject(job.params.project);
  const targetServer = requireTargetServer(job.params.targetServer);
  const gitRef = stringValue(job.params.gitRef) || project.developmentBranch || project.defaultBranch;
  const timeoutMs = Number(job.params.timeoutMs ?? (install ? 600_000 : 180_000));
  if (dependencies.remote.isLocal(targetServer)) {
    const workspacePath = await dependencies.git.syncWorkspace(project, gitRef, resolve(dependencies.config.workspaceRoot, project.id));
    const installResult = install ? await dependencies.git.installDependencies(workspacePath, timeoutMs) : undefined;
    return {
      status: 'success',
      summary: install
        ? `Repository synced and dependencies installed locally on ${targetServer.name}.`
        : `Repository synced locally on ${targetServer.name}.`,
      mode: 'local',
      targetServerId: targetServer.id,
      targetPath: workspacePath,
      gitRef,
      ...(installResult ? { install: installResult } : {}),
    };
  }
  const result = await dependencies.remote.syncProject(project, targetServer, gitRef, install, timeoutMs);
  if (result.code !== 0) throw new Error(`Remote repo ${install ? 'install' : 'sync'} failed on ${targetServer.name}: ${result.stderr || result.stdout}`);
  return {
    status: 'success',
    summary: install
      ? `Repository synced and dependencies installed on ${targetServer.name}.`
      : `Repository synced on ${targetServer.name}.`,
    mode: 'ssh',
    targetServerId: targetServer.id,
    targetPath: result.targetPath,
    gitRef,
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-4000),
    ...(install
      ? {
          peerDependencyFallback: result.stdout.includes('retrying with --legacy-peer-deps'),
          lockfileFallback: result.stdout.includes('lockfile is out of sync'),
        }
      : {}),
  };
}

async function inferRepositoryCommands(
  job: Job,
  project: Project,
  inspection: ReturnType<typeof inspectRepository>,
  workspacePath: string,
  dependencies: ExecutorDependencies,
) {
  const automationMode = project.automationMode === 'fetch_install' ? 'fetch_install' : 'deploy';
  const prompt = buildCommandInferencePrompt({ job, project, inspection, automationMode, workspacePath });
  try {
    const result = await dependencies.codex.run({
      prompt,
      workspacePath,
      sandbox: 'read-only',
      timeoutMs: Number(process.env.CODEX_COMMAND_INFERENCE_TIMEOUT_MS ?? '180000'),
    });
    return { mode: automationMode, ...parseCodexJsonResult(result.stdout), stderr: result.stderr.slice(-4000) };
  } catch (error) {
    return { mode: automationMode, ...codexExecutionFailureResult('Codex command inference could not complete.', error) };
  }
}

function environmentConfigFromInference(commandInference: Record<string, unknown>): Partial<RuntimeContract['environmentConfig']> {
  const environmentConfig = commandInference.environmentConfig && typeof commandInference.environmentConfig === 'object'
    ? commandInference.environmentConfig as Record<string, unknown>
    : {};
  const variables = Array.isArray(environmentConfig.variables)
    ? environmentConfig.variables
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
        .map((item) => ({
          key: stringValue(item.key),
          required: item.required !== false,
          type: stringValue(item.type) || (looksSecret(stringValue(item.key)) ? 'secret' : 'string'),
          managedBySystem: item.managedBySystem === true,
          defaultValue: stringValue(item.defaultValue) || undefined,
          description: stringValue(item.description) || undefined,
          envFile: stringValue(item.envFile) || undefined,
        }))
        .filter((item) => item.key)
    : [];
  const candidates = stringArray(environmentConfig.envFileCandidates).filter((item) => item.startsWith('.env'));
  const envFileName = stringValue(environmentConfig.envFileName) || candidates[0] || '.env.production';
  return {
    envFileName,
    envFileCandidates: Array.from(new Set([envFileName, ...candidates, '.env.production', '.env.local', '.env'])),
    variables,
    notes: stringArray(environmentConfig.notes),
  };
}

function databaseContractFromInference(project: Project, commandInference: Record<string, unknown>): Partial<RuntimeContract['database']> {
  const database = commandInference.database && typeof commandInference.database === 'object'
    ? commandInference.database as Record<string, unknown>
    : {};
  const initMode = project.databaseInitMode ?? 'skip';
  return {
    initMode,
    initializeData: initMode === 'init_on_first_deploy',
    migrationCommand: stringValue(database.migrationCommand) || undefined,
    dataInitCommand: initMode === 'init_on_first_deploy' ? stringValue(database.dataInitCommand) || undefined : undefined,
    notes: initMode === 'init_on_first_deploy'
      ? ['Data initialization command is metadata only until a user explicitly approves execution.']
      : ['Data initialization is disabled; inferred seed/init commands must not run.'],
  };
}
