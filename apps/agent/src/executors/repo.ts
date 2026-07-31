import { resolve } from 'node:path';
import { buildCommandInferencePrompt, codexExecutionFailureResult, parseCodexJsonResult } from '@autodevops/codex-prompts';
import type { Job, Project, RuntimeContract } from '@zhenfengxx/contracts';
import { createRuntimeContract, inspectRepository } from '@zhenfengxx/repo-inspector';
import { isJobExecutionCancelled, looksSecret, requireProject, requireTargetServer, stringArray, stringValue } from '../common.js';
import type { ExecutorDependencies, JobExecutionContext } from './types.js';

const DEFAULT_REPO_INSTALL_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_REPO_SYNC_TIMEOUT_MS = 3 * 60 * 1_000;

export async function executeRepoInspect(job: Job, dependencies: ExecutorDependencies, context: JobExecutionContext) {
  const project = requireProject(job.params.project);
  const gitRef = stringValue(job.params.gitRef) || project.developmentBranch || project.defaultBranch;
  const workspacePath = await dependencies.git.syncWorkspace(project, gitRef, undefined, context.signal);
  const commitSha = await dependencies.git.head(workspacePath, context.signal);
  const inspection = inspectRepository(project.id, workspacePath);
  const automationMode = project.automationMode ?? 'deploy';
  const commandInference = automationMode === 'fetch_only'
    ? {
        mode: automationMode,
        status: 'skipped',
        summary: 'Fetch-only mode skips Codex command inference.',
        commands: { checkout: ['git fetch origin --tags --prune', `git checkout --detach ${commitSha}`] },
      }
    : await inferRepositoryCommands(job, project, inspection, workspacePath, dependencies, context);
  const requestedOverrides = (job.params.overrides as Partial<RuntimeContract>) ?? {};
  const inferredDeployment = deploymentContractFromInference(commandInference, inspection);
  const generateRuntimeContract = job.params.generateRuntimeContract !== false;
  const contract = generateRuntimeContract
    ? createRuntimeContract(project, inspection, {
        ...requestedOverrides,
        automationMode,
        commandInference,
        build: { ...inferredDeployment.build, ...requestedOverrides.build },
        pm2: { ...inferredDeployment.pm2, ...requestedOverrides.pm2 } as RuntimeContract['pm2'],
        database: { ...databaseContractFromInference(project, commandInference), ...requestedOverrides.database },
        environmentConfig: { ...environmentConfigFromInference(commandInference), ...requestedOverrides.environmentConfig },
      } as Partial<RuntimeContract>)
    : undefined;
  return {
    status: 'success',
    summary: generateRuntimeContract ? 'Repository inspected and runtime contract generated.' : 'Repository inspected.',
    workspacePath,
    gitRef,
    commitSha,
    inspection,
    automationMode,
    commandInference,
    contract,
    generateRuntimeContract,
  };
}

export async function executeRepoSync(job: Job, dependencies: ExecutorDependencies, context: JobExecutionContext) {
  return executeRepoDelivery(job, dependencies, false, context);
}

function deploymentContractFromInference(
  commandInference: Record<string, unknown>,
  inspection: ReturnType<typeof inspectRepository>,
): {
  build: Partial<RuntimeContract['build']>;
  pm2: Partial<NonNullable<RuntimeContract['pm2']>>;
} {
  const runtimeContract = commandInference.runtimeContract && typeof commandInference.runtimeContract === 'object'
    ? commandInference.runtimeContract as Record<string, unknown>
    : {};
  const frontendBuildCommand = stringValue(runtimeContract.frontendBuildCommand) || undefined;
  const frontendDistDir = normalizeRepositoryRelativePath(stringValue(runtimeContract.frontendDistDir));
  const serverBuildCommand = stringValue(runtimeContract.serverBuildCommand) || undefined;
  const pm2StartCommand = productionPm2Command(stringValue(runtimeContract.pm2StartCommand), inspection);
  return {
    build: {
      ...(serverBuildCommand ? { serverBuildCommand } : {}),
      ...(frontendBuildCommand ? { frontendBuildCommand, ...(frontendDistDir ? { frontendDistDir } : {}) } : {}),
    },
    pm2: {
      ...(pm2StartCommand ? { startCommand: pm2StartCommand } : {}),
    },
  };
}

function productionPm2Command(value: string, inspection: ReturnType<typeof inspectRepository>) {
  const command = value.trim();
  if (!command || looksLikeDevelopmentCommand(command)) return undefined;
  const scriptName = command.match(/^(?:npm|pnpm|bun)\s+run\s+([^\s]+)$/)?.[1]
    ?? command.match(/^yarn\s+(?:run\s+)?([^\s]+)$/)?.[1]
    ?? (command === 'npm start' ? 'start' : undefined);
  const scriptBody = scriptName ? inspection.scripts[scriptName] : undefined;
  if (scriptName && !scriptBody) return undefined;
  if (scriptBody && looksLikeDevelopmentCommand(scriptBody)) return undefined;
  return command;
}

function looksLikeDevelopmentCommand(command: string) {
  return /\b(?:development|dev|watch|nodemon|tsx\s+watch|ts-node-dev)\b/i.test(command);
}

function normalizeRepositoryRelativePath(value: string) {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) return undefined;
  return normalized;
}

export async function executeRepoInstall(job: Job, dependencies: ExecutorDependencies, context: JobExecutionContext) {
  return executeRepoDelivery(job, dependencies, true, context);
}

async function executeRepoDelivery(job: Job, dependencies: ExecutorDependencies, install: boolean, context: JobExecutionContext) {
  const project = requireProject(job.params.project);
  const targetServer = requireTargetServer(job.params.targetServer);
  const gitRef = stringValue(job.params.gitRef) || project.developmentBranch || project.defaultBranch;
  const timeoutMs = Number(job.params.timeoutMs ?? (install ? DEFAULT_REPO_INSTALL_TIMEOUT_MS : DEFAULT_REPO_SYNC_TIMEOUT_MS));
  if (dependencies.remote.isLocal(targetServer)) {
    const workspacePath = await dependencies.git.syncWorkspace(project, gitRef, resolve(dependencies.config.workspaceRoot, project.id), context.signal);
    const commitSha = await dependencies.git.head(workspacePath, context.signal);
    const installResult = install ? await dependencies.git.installDependencies(workspacePath, timeoutMs, context.signal) : undefined;
    return {
      status: 'success',
      summary: install
        ? `Repository synced and dependencies installed locally on ${targetServer.name}.`
        : `Repository synced locally on ${targetServer.name}.`,
      mode: 'local',
      targetServerId: targetServer.id,
      targetPath: workspacePath,
      gitRef,
      commitSha,
      ...(installResult ? { install: installResult } : {}),
    };
  }
  const result = await dependencies.remote.syncProject(project, targetServer, gitRef, install, timeoutMs, context.signal);
  if (result.code !== 0) throw new Error(`Remote repo ${install ? 'install' : 'sync'} failed on ${targetServer.name}: ${result.stderr || result.stdout}`);
  if (!result.commitSha) throw new Error(`Remote repo ${install ? 'install' : 'sync'} on ${targetServer.name} did not report its resolved commit SHA.`);
  return {
    status: 'success',
    summary: install
      ? `Repository synced and dependencies installed on ${targetServer.name}.`
      : `Repository synced on ${targetServer.name}.`,
    mode: 'ssh',
    targetServerId: targetServer.id,
    targetPath: result.targetPath,
    gitRef,
    commitSha: result.commitSha,
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
  context: JobExecutionContext,
) {
  const automationMode = project.automationMode === 'fetch_install' ? 'fetch_install' : 'deploy';
  const prompt = buildCommandInferencePrompt({ job, project, inspection, automationMode, workspacePath });
  try {
    const result = await dependencies.codex.run({
      prompt,
      workspacePath,
      sandbox: 'read-only',
      timeoutMs: Number(process.env.CODEX_COMMAND_INFERENCE_TIMEOUT_MS ?? '180000'),
      signal: context.signal,
    });
    return { mode: automationMode, ...parseCodexJsonResult(result.stdout), stderr: result.stderr.slice(-4000) };
  } catch (error) {
    if (isJobExecutionCancelled(error)) throw error;
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
