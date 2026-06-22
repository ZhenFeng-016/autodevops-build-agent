import './load-env.js';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildCommandInferencePrompt, buildFixApplyPrompt, buildIncidentAnalysisPrompt, codexExecutionFailureResult, parseCodexJsonResult } from '@autodevops/codex-prompts';
import { generateCodexFixBranchName, newEntityId, type BuildAgent, type ClaimedJob, type Job, type Project, type RuntimeContract } from '@zhenfengxx/contracts';
import { createRuntimeContract, inspectRepository } from '@zhenfengxx/repo-inspector';
import { agentAuthHeaders } from '@zhenfengxx/agent-sdk';
import { JenkinsClient, runCodexExec } from '@autodevops/integrations';

declare const __AUTODEVOPS_AGENT_VERSION__: string;
declare const __AUTODEVOPS_AGENT_REVISION__: string;

const BUNDLED_AGENT_VERSION =
  typeof __AUTODEVOPS_AGENT_VERSION__ !== 'undefined'
    ? `${__AUTODEVOPS_AGENT_VERSION__}+${typeof __AUTODEVOPS_AGENT_REVISION__ !== 'undefined' ? __AUTODEVOPS_AGENT_REVISION__ : 'unknown'}`
    : undefined;

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`autodevops-agent ${BUNDLED_AGENT_VERSION ?? 'development'}`);
  process.exit(0);
}

const execFileAsync = promisify(execFile);

const API_BASE_URL = requiredEnv('AUTODEVOPS_API_URL', 'http://127.0.0.1:3000').replace(/\/$/, '');
const WORKSPACE_ROOT = resolve(requiredEnv('AUTODEVOPS_AGENT_WORKSPACE_ROOT', join(process.cwd(), '.autodevops', 'agent-workspaces')));
const AGENT_ID = process.env.AUTODEVOPS_AGENT_ID || loadPersistentAgentId();
const AGENT_NAME = requiredEnv('AUTODEVOPS_AGENT_NAME', hostname());
const POLL_INTERVAL_MS = Number(process.env.AUTODEVOPS_AGENT_POLL_INTERVAL_MS ?? '10000');
const RUN_ONCE = truthy(process.env.AUTODEVOPS_AGENT_RUN_ONCE);
const AUTH_SECRET = process.env.AUTODEVOPS_AGENT_AUTH_SECRET;
const AUTH_TOKEN = process.env.AUTODEVOPS_AGENT_AUTH_TOKEN;
const CODEX_CLI = process.env.CODEX_CLI || 'codex';
const GIT_SSH_KEY_PATH = process.env.AUTODEVOPS_GIT_SSH_KEY_PATH;

configureGitSshCommand();

const BASE_CAPABILITIES = [
  'repo.inspect',
  'repo.sync',
  'jenkins.run',
  'codex.exec',
  'codex.fix',
  'repo.write',
  'incident.analyze',
  'observability.preflight',
];

async function main() {
  mkdirSync(WORKSPACE_ROOT, { recursive: true });
  await register();
  while (true) {
    try {
      await heartbeat();
      const claim = await claimJob();
      if ('claimed' in claim && claim.claimed === false) {
        if (RUN_ONCE) break;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await executeClaim(claim as ClaimedJob);
    } catch (error) {
      log(`agent loop error: ${errorMessage(error)}`);
      if (RUN_ONCE) throw error;
      await sleep(POLL_INTERVAL_MS);
    }
    if (RUN_ONCE) break;
  }
}

async function register() {
  const readiness = await buildReadiness();
  await apiFetch('/build-agents/register', 'POST', {
    id: AGENT_ID,
    name: AGENT_NAME,
    status: readiness.ready ? 'online' : 'degraded',
    serverId: process.env.AUTODEVOPS_AGENT_SERVER_ID,
    endpoint: `local://${hostname()}`,
    capabilities: BASE_CAPABILITIES,
    readiness,
    runtimeStatus: await runtimeStatus(),
    metadata: {
      workspaceRoot: WORKSPACE_ROOT,
      hostname: hostname(),
      codexHome: process.env.CODEX_HOME,
      serviceManager: process.env.AUTODEVOPS_AGENT_SERVICE_MANAGER ?? 'pm2',
    },
    version: await agentVersion(),
  });
  log(`registered ${AGENT_ID}`);
}

async function heartbeat() {
  const readiness = await buildReadiness();
  await apiFetch(`/build-agents/${encodeURIComponent(AGENT_ID)}/heartbeat`, 'POST', {
    status: readiness.ready ? 'online' : 'degraded',
    serverId: process.env.AUTODEVOPS_AGENT_SERVER_ID,
    capabilities: BASE_CAPABILITIES,
    readiness,
    runtimeStatus: await runtimeStatus(),
    metadata: {
      workspaceRoot: WORKSPACE_ROOT,
      hostname: hostname(),
      codexSkills: await codexSkills(),
    },
    version: await agentVersion(),
  });
}

async function claimJob(): Promise<ClaimedJob | { claimed: false }> {
  return apiFetch<ClaimedJob | { claimed: false }>(`/build-agents/${encodeURIComponent(AGENT_ID)}/claim-job`, 'POST', {
    capabilities: BASE_CAPABILITIES,
    leaseSeconds: 900,
  });
}

async function executeClaim(claim: ClaimedJob) {
  const { job, attempt } = claim;
  log(`claimed ${job.id} ${job.type}`);
  try {
    await jobEvent(job.id, attempt.id, 'agent.started', 'running', `Agent ${AGENT_ID} started ${job.type}`);
    const resultSummary = await executeJob(job);
    await apiFetch(`/jobs/${encodeURIComponent(job.id)}/complete`, 'POST', {
      agentId: AGENT_ID,
      attemptId: attempt.id,
      agentWorkspacePath: typeof resultSummary.workspacePath === 'string' ? resultSummary.workspacePath : undefined,
      resultSummary,
    });
    log(`completed ${job.id}`);
  } catch (error) {
    const message = errorMessage(error);
    await apiFetch(`/jobs/${encodeURIComponent(job.id)}/fail`, 'POST', {
      agentId: AGENT_ID,
      attemptId: attempt.id,
      errorSummary: message,
    }).catch((failError) => log(`failed to report job failure: ${errorMessage(failError)}`));
    log(`failed ${job.id}: ${message}`);
  }
}

async function executeJob(job: Job): Promise<Record<string, unknown>> {
  if (job.type === 'repo.inspect') return executeRepoInspect(job);
  if (job.type === 'repo.sync') return executeRepoSync(job);
  if (job.type === 'repo.install') return executeRepoInstall(job);
  if (job.type === 'jenkins.pipeline.run') return executeJenkinsRun(job);
  if (job.type === 'codex.incident.analyze') return executeIncidentAnalysis(job);
  if (job.type === 'codex.fix.create_patch') return executeCodexFix(job);
  if (job.type === 'codex.fix.merge_to_production') return executeCodexFixMerge(job);
  return { status: 'success', summary: 'Observability preflight placeholder completed.' };
}

async function executeRepoInspect(job: Job) {
  const project = requireProject(job.params.project);
  const workspacePath = await syncWorkspace(project, stringValue(job.params.gitRef) || project.developmentBranch || project.defaultBranch);
  const inspection = inspectRepository(project.id, workspacePath);
  const automationMode = project.automationMode ?? 'deploy';
  const commandInference = automationMode === 'fetch_only'
    ? {
        mode: automationMode,
        status: 'skipped',
        summary: 'Fetch-only mode skips Codex command inference.',
        commands: {
          checkout: ['git fetch --all --tags --prune', `git checkout ${stringValue(job.params.gitRef) || project.developmentBranch || project.defaultBranch}`],
        },
      }
    : await inferRepositoryCommands(job, project, inspection, workspacePath);
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

async function executeRepoSync(job: Job) {
  const project = requireProject(job.params.project);
  const targetServer = requireTargetServer(job.params.targetServer);
  const gitRef = stringValue(job.params.gitRef) || project.developmentBranch || project.defaultBranch;
  const targetPath = targetPathForProject(project, targetServer);
  const local = isLocalTarget(targetServer);
  if (local) {
    const workspacePath = await syncWorkspaceToPath(project, gitRef, resolve(WORKSPACE_ROOT, project.id));
    return {
      status: 'success',
      summary: `Repository synced locally on ${targetServer.name}.`,
      mode: 'local',
      targetServerId: targetServer.id,
      targetPath: workspacePath,
      gitRef,
    };
  }
  const result = await runRemoteProjectCommand(targetServer, repoSyncScript(project.repositoryUrl, gitRef, targetPath), Number(job.params.timeoutMs ?? 180_000));
  if (result.code !== 0) throw new Error(`Remote repo sync failed on ${targetServer.name}: ${result.stderr || result.stdout}`);
  return {
    status: 'success',
    summary: `Repository synced on ${targetServer.name}.`,
    mode: 'ssh',
    targetServerId: targetServer.id,
    targetPath,
    gitRef,
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-4000),
  };
}

async function executeRepoInstall(job: Job) {
  const project = requireProject(job.params.project);
  const targetServer = requireTargetServer(job.params.targetServer);
  const gitRef = stringValue(job.params.gitRef) || project.developmentBranch || project.defaultBranch;
  const targetPath = targetPathForProject(project, targetServer);
  const timeoutMs = Number(job.params.timeoutMs ?? 600_000);
  const local = isLocalTarget(targetServer);
  if (local) {
    const workspacePath = await syncWorkspaceToPath(project, gitRef, resolve(WORKSPACE_ROOT, project.id));
    const install = await installDependencies(workspacePath, timeoutMs);
    return {
      status: 'success',
      summary: `Repository synced and dependencies installed locally on ${targetServer.name}.`,
      mode: 'local',
      targetServerId: targetServer.id,
      targetPath: workspacePath,
      gitRef,
      install,
    };
  }
  const result = await runRemoteProjectCommand(targetServer, `${repoSyncScript(project.repositoryUrl, gitRef, targetPath)}\n${repoInstallScript(targetPath)}`, timeoutMs);
  if (result.code !== 0) throw new Error(`Remote repo install failed on ${targetServer.name}: ${result.stderr || result.stdout}`);
  return {
    status: 'success',
    summary: `Repository synced and dependencies installed on ${targetServer.name}.`,
    mode: 'ssh',
    targetServerId: targetServer.id,
    targetPath,
    gitRef,
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-4000),
    peerDependencyFallback: result.stdout.includes('retrying with --legacy-peer-deps'),
    lockfileFallback: result.stdout.includes('lockfile is out of sync'),
  };
}

function environmentConfigFromInference(commandInference: Record<string, unknown>): Partial<RuntimeContract['environmentConfig']> {
  const environmentConfig = commandInference.environmentConfig && typeof commandInference.environmentConfig === 'object' ? (commandInference.environmentConfig as Record<string, unknown>) : {};
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
  const database = commandInference.database && typeof commandInference.database === 'object' ? (commandInference.database as Record<string, unknown>) : {};
  const initMode = project.databaseInitMode ?? 'skip';
  return {
    initMode,
    initializeData: initMode === 'init_on_first_deploy',
    migrationCommand: stringValue(database.migrationCommand) || undefined,
    dataInitCommand: initMode === 'init_on_first_deploy' ? stringValue(database.dataInitCommand) || undefined : undefined,
    notes:
      initMode === 'init_on_first_deploy'
        ? ['Data initialization command is metadata only until a user explicitly approves execution.']
        : ['Data initialization is disabled; inferred seed/init commands must not run.'],
  };
}

async function inferRepositoryCommands(job: Job, project: Project, inspection: ReturnType<typeof inspectRepository>, workspacePath: string) {
  const automationMode = project.automationMode === 'fetch_install' ? 'fetch_install' : 'deploy';
  const prompt = buildCommandInferencePrompt({
    job,
    project,
    inspection,
    automationMode,
    workspacePath,
  });
  try {
    const result = await runCodexExec({
      prompt,
      workspacePath,
      sandbox: 'read-only',
      codexCli: CODEX_CLI,
      timeoutMs: Number(process.env.CODEX_COMMAND_INFERENCE_TIMEOUT_MS ?? '180000'),
    });
    return {
      mode: automationMode,
      ...parseCodexJsonResult(result.stdout),
      stderr: result.stderr.slice(-4000),
    };
  } catch (error) {
    return {
      mode: automationMode,
      ...codexExecutionFailureResult('Codex command inference could not complete.', error),
    };
  }
}

async function executeJenkinsRun(job: Job) {
  const definition = job.params.definition as { jenkinsJobName?: string; jenkinsfile?: string } | undefined;
  const project = requireProject(job.params.project);
  const jenkins = job.params.jenkins && typeof job.params.jenkins === 'object' ? (job.params.jenkins as Record<string, unknown>) : {};
  const baseUrl = stringValue(jenkins.baseUrl) || requiredEnv('JENKINS_BASE_URL', '');
  const username = stringValue(jenkins.username) || process.env.JENKINS_USERNAME || process.env.JENKINS_USER;
  const apiToken = stringValue(jenkins.apiToken) || process.env.JENKINS_API_TOKEN || process.env.JENKINS_TOKEN;
  if (!baseUrl) {
    return {
      status: 'warning',
      summary: 'Jenkins is not configured on this build agent; pipeline run remains queued.',
      jenkinsConfigured: false,
    };
  }
  const client = new JenkinsClient({
    baseUrl,
    username,
    apiToken,
  });
  if (definition?.jenkinsJobName && definition.jenkinsfile) {
    await client.upsertPipelineJob(definition.jenkinsJobName, definition.jenkinsfile);
  }
  const queue = await client.triggerBuild(required(definition?.jenkinsJobName, 'jenkinsJobName'), {
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
  });
  return {
    status: 'success',
    summary: 'Jenkins pipeline triggered by build agent.',
    jenkinsConfigured: true,
    jenkinsQueueUrl: queue.queueUrl,
  };
}

async function executeIncidentAnalysis(job: Job) {
  const incident = job.params.incident as never;
  const prompt = buildIncidentAnalysisPrompt({
    job,
    incident,
    evidence: (job.params.evidence as Record<string, unknown>) ?? {},
  });
  try {
    const result = await runCodexExec({
      prompt,
      workspacePath: WORKSPACE_ROOT,
      sandbox: 'read-only',
      codexCli: CODEX_CLI,
      timeoutMs: Number(process.env.CODEX_INCIDENT_ANALYSIS_TIMEOUT_MS ?? '120000'),
    });
    return {
      analysis: parseCodexJsonResult(result.stdout),
      stderr: result.stderr.slice(-4000),
    };
  } catch (error) {
    return {
      analysis: codexExecutionFailureResult('Codex incident analysis could not complete.', error),
    };
  }
}

async function executeCodexFix(job: Job) {
  const incident = job.params.incident as never;
  const projectRecord = job.params.project ? requireProject(job.params.project) : await fetchProject(stringValue((job.params.incident as { projectId?: string }).projectId));
  const baseBranch = stringValue(job.params.baseBranch) || projectRecord.productionBranch || projectRecord.defaultBranch;
  const targetBranch = stringValue(job.params.targetBranch) || projectRecord.productionBranch || projectRecord.defaultBranch;
  const workspacePath = await syncWorkspace(projectRecord, baseBranch);
  const branchName = stringValue(job.params.branchName) || generateCodexFixBranchName({
    projectId: projectRecord.id,
    incidentId: stringValue(job.incidentId) || job.id,
    fixId: stringValue(job.codexFixId) || job.id,
  });
  await git(workspacePath, ['checkout', '-B', branchName, baseBranch]);
  const prompt = buildFixApplyPrompt({
    job,
    incident,
    workspacePath,
    branchName,
    baseBranch,
    targetBranch,
  });
  try {
    const result = await runCodexExec({
      prompt,
      workspacePath,
      sandbox: 'workspace-write',
      codexCli: CODEX_CLI,
      timeoutMs: Number(process.env.CODEX_FIX_TIMEOUT_MS ?? '600000'),
    });
    const parsed = parseCodexJsonResult(result.stdout);
    const commit = await commitAndPushFixBranch(workspacePath, branchName, incident);
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
    return {
      ...codexExecutionFailureResult('Codex fix job could not complete.', error),
      branchName,
      baseBranch,
      targetBranch,
      workspacePath,
    };
  }
}

async function executeCodexFixMerge(job: Job) {
  const fix = job.params.fix as { projectId?: string; branchName?: string; targetBranch?: string; baseBranch?: string } | undefined;
  const projectRecord = job.params.project ? requireProject(job.params.project) : await fetchProject(stringValue(fix?.projectId));
  const branchName = required(stringValue(job.params.branchName) || fix?.branchName, 'branchName');
  const targetBranch = stringValue(job.params.targetBranch) || fix?.targetBranch || projectRecord.productionBranch || projectRecord.defaultBranch;
  const baseBranch = stringValue(job.params.baseBranch) || fix?.baseBranch || targetBranch;
  const workspacePath = await syncWorkspace(projectRecord, targetBranch);
  await git(workspacePath, ['fetch', 'origin', branchName], 180_000).catch(() => undefined);
  await git(workspacePath, ['checkout', targetBranch]);
  await git(workspacePath, ['reset', '--hard', `origin/${targetBranch}`]).catch(() => git(workspacePath, ['reset', '--hard', targetBranch]));
  await git(workspacePath, ['merge', '--no-ff', branchName, '-m', `Merge ${branchName} into ${targetBranch}`], 180_000);
  await git(workspacePath, ['push', 'origin', targetBranch], 180_000);
  return {
    status: 'success',
    summary: `Merged ${branchName} into ${targetBranch}.`,
    branchName,
    baseBranch,
    targetBranch,
    mergeCommitSha: await gitHead(workspacePath),
    workspacePath,
  };
}

async function syncWorkspace(project: Project, gitRef: string) {
  return syncWorkspaceToPath(project, gitRef, resolve(WORKSPACE_ROOT, project.id));
}

async function syncWorkspaceToPath(project: Project, gitRef: string, workspacePath: string) {
  if (!workspacePath.startsWith(WORKSPACE_ROOT)) throw new Error('Workspace path escaped agent workspace root');
  mkdirSync(WORKSPACE_ROOT, { recursive: true });
  if (!existsSync(join(workspacePath, '.git'))) {
    await execFileAsync('git', ['clone', '--branch', gitRef, project.repositoryUrl, workspacePath], { timeout: 180_000 });
  } else {
    await git(workspacePath, ['fetch', '--all', '--tags', '--prune'], 180_000);
  }
  await git(workspacePath, ['checkout', gitRef], 60_000);
  await git(workspacePath, ['reset', '--hard', 'HEAD'], 60_000);
  await git(workspacePath, ['clean', '-fd'], 60_000);
  return workspacePath;
}

type TargetServer = {
  id: string;
  name: string;
  role: string;
  host?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshTarget?: string;
  sshAuthType?: string;
  basePath?: string;
};

function requireTargetServer(value: unknown): TargetServer {
  if (!value || typeof value !== 'object') throw new Error('targetServer is required');
  const server = value as TargetServer;
  if (!server.id) throw new Error('targetServer.id is required');
  if (!server.name) throw new Error('targetServer.name is required');
  return server;
}

function isLocalTarget(server: TargetServer) {
  return server.id === process.env.AUTODEVOPS_AGENT_SERVER_ID;
}

function targetPathForProject(project: Project, server: TargetServer) {
  if (isLocalTarget(server)) return resolve(WORKSPACE_ROOT, project.id);
  const basePath = (server.basePath || '/opt/autodevops').replace(/\/$/, '');
  if (server.role === 'runtime') return project.productionServerPath || `${basePath}/apps/${project.id}`;
  if (server.role === 'build') return `${basePath}/workspaces/${project.id}`;
  return `${basePath}/repos/${project.id}`;
}

function repoSyncScript(repositoryUrl: string, gitRef: string, targetPath: string) {
  return [
    'set -euo pipefail',
    `target=${shellQuote(targetPath)}`,
    `repo=${shellQuote(repositoryUrl)}`,
    `ref=${shellQuote(gitRef)}`,
    'current_user="$(id -un)"',
    'current_group="$(id -gn)"',
    'SUDO=""',
    'if [ "$(id -u)" != "0" ]; then',
    '  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then',
    '    SUDO="sudo -n"',
    '  fi',
    'fi',
    'parent="$(dirname "$target")"',
    'if ! mkdir -p "$parent" 2>/dev/null; then',
    '  if [ -z "$SUDO" ]; then',
    '    echo "Cannot create $parent and passwordless sudo is unavailable." >&2',
    '    exit 73',
    '  fi',
    '  $SUDO mkdir -p "$parent"',
    '  $SUDO chown "$current_user:$current_group" "$parent"',
    'fi',
    'if [ -e "$target" ] && [ ! -w "$target" ]; then',
    '  if [ -z "$SUDO" ]; then',
    '    echo "Cannot write $target and passwordless sudo is unavailable." >&2',
    '    exit 74',
    '  fi',
    '  $SUDO chown -R "$current_user:$current_group" "$target"',
    'fi',
    remoteGitAuthScript(),
    'if [ ! -d "$target/.git" ]; then',
    '  git clone "$repo" "$target"',
    'fi',
    'cd "$target"',
    'git remote set-url origin "$repo" || true',
    'git fetch --all --tags --prune',
    'git checkout "$ref"',
    'git reset --hard "$ref"',
    'git clean -fd',
    'printf "synced:%s:%s\\n" "$target" "$ref"',
  ].join('\n');
}

function remoteGitAuthScript() {
  if (!GIT_SSH_KEY_PATH || !existsSync(GIT_SSH_KEY_PATH)) {
    return 'export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30"';
  }
  const encodedKey = Buffer.from(readFileSync(GIT_SSH_KEY_PATH, 'utf8')).toString('base64');
  return [
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    `printf %s ${shellQuote(encodedKey)} | base64 -d > "$HOME/.ssh/autodevops_git_key"`,
    'chmod 600 "$HOME/.ssh/autodevops_git_key"',
    'export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/autodevops_git_key -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30"',
  ].join('\n');
}

function repoInstallScript(targetPath: string) {
  return [
    `cd ${shellQuote(targetPath)}`,
    'export NODE_ENV=development npm_config_omit=',
    'npm_with_peer_fallback() {',
    '  local npm_log npm_code',
    '  npm_log="$(mktemp)"',
    '  if "$@" 2> >(tee "$npm_log" >&2); then rm -f "$npm_log"; return 0; else npm_code=$?; fi',
    '  if grep -q "ERESOLVE" "$npm_log"; then',
    '    echo "Strict npm dependency resolution failed with ERESOLVE; retrying with --legacy-peer-deps."',
    '    rm -f "$npm_log"',
    '    "$@" --legacy-peer-deps',
    '    return $?',
    '  fi',
    '  if [ "${1:-}" = "npm" ] && [ "${2:-}" = "ci" ] && grep -q "can only install packages when.*in sync" "$npm_log"; then',
    '    echo "Committed npm lockfile is out of sync; retrying without modifying package-lock.json."',
    '    rm -f "$npm_log"',
    '    npm_with_peer_fallback npm install --include=dev --package-lock=false',
    '    return $?',
    '  fi',
    '  rm -f "$npm_log"',
    '  return "$npm_code"',
    '}',
    'if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then pnpm install --frozen-lockfile --prod=false;',
    'elif [ -f package-lock.json ] && git ls-files --error-unmatch -- package-lock.json >/dev/null 2>&1; then npm_with_peer_fallback npm ci --include=dev;',
    'elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then yarn install --frozen-lockfile --production=false;',
    'elif [ -f package.json ]; then rm -f package-lock.json; npm_with_peer_fallback npm install --include=dev --package-lock=false;',
    'else echo "No package.json found; dependency install skipped."; fi',
  ].join('\n');
}

async function installDependencies(cwd: string, timeoutMs: number) {
  const npmLockTracked = existsSync(join(cwd, 'package-lock.json')) && (await gitFileIsTracked(cwd, 'package-lock.json'));
  const command = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : npmLockTracked ? 'npm' : existsSync(join(cwd, 'yarn.lock')) ? 'yarn' : existsSync(join(cwd, 'package.json')) ? 'npm' : '';
  if (!command) return { skipped: true, reason: 'No package.json found' };
  if (command === 'npm' && !npmLockTracked) rmSync(join(cwd, 'package-lock.json'), { force: true });
  const args =
    command === 'pnpm'
      ? ['install', '--frozen-lockfile', '--prod=false']
      : command === 'yarn'
        ? ['install', '--frozen-lockfile', '--production=false']
        : npmLockTracked
          ? ['ci', '--include=dev']
          : ['install', '--include=dev', '--package-lock=false'];
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    npm_config_omit: '',
  };
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, timeout: timeoutMs, env });
    return { command: [command, ...args].join(' '), stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), peerDependencyFallback: false, lockfileFallback: false };
  } catch (error) {
    const output = commandErrorOutput(error);
    if (command !== 'npm') throw error;
    if (args[0] === 'ci' && /can only install packages when[\s\S]*in sync/i.test(output)) {
      const installArgs = ['install', '--include=dev', '--package-lock=false'];
      try {
        const { stdout, stderr } = await execFileAsync(command, installArgs, { cwd, timeout: timeoutMs, env });
        return {
          command: [command, ...installArgs].join(' '),
          stdout: stdout.slice(-4000),
          stderr: stderr.slice(-4000),
          peerDependencyFallback: false,
          lockfileFallback: true,
          fallbackReason: 'Committed npm lockfile is out of sync with package.json.',
        };
      } catch (installError) {
        if (!/\bERESOLVE\b/.test(commandErrorOutput(installError))) throw installError;
        const fallbackArgs = [...installArgs, '--legacy-peer-deps'];
        const { stdout, stderr } = await execFileAsync(command, fallbackArgs, { cwd, timeout: timeoutMs, env });
        return {
          command: [command, ...fallbackArgs].join(' '),
          stdout: stdout.slice(-4000),
          stderr: stderr.slice(-4000),
          peerDependencyFallback: true,
          lockfileFallback: true,
          fallbackReason: 'Committed npm lockfile is out of sync and strict peer dependency resolution failed.',
        };
      }
    }
    if (!/\bERESOLVE\b/.test(output)) throw error;
    const fallbackArgs = [...args, '--legacy-peer-deps'];
    const { stdout, stderr } = await execFileAsync(command, fallbackArgs, { cwd, timeout: timeoutMs, env });
    return {
      command: [command, ...fallbackArgs].join(' '),
      stdout: stdout.slice(-4000),
      stderr: stderr.slice(-4000),
      peerDependencyFallback: true,
      lockfileFallback: false,
      fallbackReason: 'Strict npm dependency resolution failed with ERESOLVE.',
    };
  }
}

async function gitFileIsTracked(cwd: string, path: string) {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', path], { cwd, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function commandErrorOutput(error: unknown) {
  if (!error || typeof error !== 'object') return errorMessage(error);
  const candidate = error as { message?: string; stdout?: string; stderr?: string };
  return [candidate.message, candidate.stdout, candidate.stderr].filter(Boolean).join('\n');
}

async function runRemoteProjectCommand(server: TargetServer, script: string, timeoutMs: number) {
  const args = sshArgsForServer(server);
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise) => {
    const child = spawn('ssh', [...args, 'bash', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      stderr += `\nRemote command timed out after ${timeoutMs}ms.`;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
    child.stdin.end(script);
  });
}

function sshArgsForServer(server: TargetServer) {
  if (server.sshAuthType === 'system_default' && server.sshTarget) return splitShellWords(server.sshTarget.replace(/^ssh\s+/, ''));
  const platformForwarded = isLoopbackHost(server.sshHost) && server.host && !isLoopbackHost(server.host);
  const host = platformForwarded ? server.host : server.sshHost || server.host;
  const user = server.sshUser;
  if (!host || !user) throw new Error(`Server ${server.name} is missing sshHost/host or sshUser`);
  const args = ['-p', String(platformForwarded ? 22 : server.sshPort ?? 22), '-o', 'StrictHostKeyChecking=accept-new'];
  if (GIT_SSH_KEY_PATH) args.push('-i', GIT_SSH_KEY_PATH, '-o', 'IdentitiesOnly=yes');
  args.push(`${user}@${host}`);
  return args;
}

function isLoopbackHost(value?: string) {
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

function splitShellWords(value: string) {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')) ?? [];
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function fetchProject(projectId: string) {
  return apiFetch<Project[]>(`/projects`, 'GET', undefined).then((projects) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  });
}

async function jobEvent(jobId: string, attemptId: string, type: string, status: string, message: string) {
  await apiFetch(`/jobs/${encodeURIComponent(jobId)}/events`, 'POST', {
    agentId: AGENT_ID,
    attemptId,
    type,
    status,
    message,
  });
}

async function apiFetch<T>(path: string, method: string, body: unknown): Promise<T> {
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      ...(body === undefined ? { Accept: 'application/json' } : agentAuthHeaders({ method, path, body, agentId: AGENT_ID, secret: AUTH_SECRET, token: AUTH_TOKEN })),
    },
    body: rawBody,
  });
  if (!response.ok) throw new Error(`API ${method} ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function buildReadiness() {
  const skillStatus = await codexSkills();
  const checks = [
    await commandCheck('git', ['--version']),
    await commandCheck('node', ['--version']),
    await commandCheck('npm', ['--version']),
    await commandCheck('pnpm', ['--version'], true),
    await commandCheck('docker', ['--version'], true),
    await commandCheck(CODEX_CLI, ['--version'], true),
    {
      name: 'oak-framework skill',
      status: skillStatus.oakFrameworkAvailable ? ('pass' as const) : ('warn' as const),
      message: skillStatus.oakFrameworkAvailable
        ? `found ${skillStatus.oakFramework.resolvedPath ?? skillStatus.oakFramework.skillPath}`
        : `missing ${skillStatus.oakFramework.checkedPaths.join(', ')}`,
    },
  ];
  return {
    ready: checks.every((check) => check.status !== 'fail'),
    status: checks.some((check) => check.status === 'fail') ? 'blocked' : checks.some((check) => check.status === 'warn') ? 'degraded' : 'ready',
    checks,
  };
}

async function runtimeStatus() {
  return {
    hostname: hostname(),
    pid: process.pid,
    workspaceRoot: WORKSPACE_ROOT,
    nodeVersion: process.version,
    serviceManager: process.env.AUTODEVOPS_AGENT_SERVICE_MANAGER ?? 'pm2',
  };
}

async function codexSkills() {
  const codexHome = process.env.CODEX_HOME || join(process.env.HOME || '', '.codex');
  const oakFramework = await inspectOakFrameworkSkill(codexHome);
  return {
    codexHome,
    oakFrameworkAvailable: oakFramework.available,
    oakFramework,
  };
}

async function inspectOakFrameworkSkill(codexHome: string) {
  const checkedPaths = [
    join(codexHome, 'skills', 'oak-framework'),
    join(codexHome, 'oak-skills', 'skills', 'oak-framework'),
  ];
  for (const skillPath of checkedPaths) {
    const skillMdPath = join(skillPath, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;
    const resolvedPath = resolveExistingPath(skillPath);
    const repoPath = findGitRepoRoot(resolvedPath ?? skillPath);
    return {
      available: true,
      checkedPaths,
      skillPath,
      resolvedPath,
      skillMdPath,
      skillMdExists: true,
      skillPathIsSymlink: isSymlink(skillPath),
      agentsMdPath: join(codexHome, 'AGENTS.md'),
      agentsMdExists: existsSync(join(codexHome, 'AGENTS.md')),
      oakSkillsPath: join(codexHome, 'oak-skills'),
      oakSkillsExists: existsSync(join(codexHome, 'oak-skills')),
      repoPath,
      repoHead: repoPath ? await gitHead(repoPath).catch(() => undefined) : undefined,
    };
  }
  return {
    available: false,
    checkedPaths,
    skillMdExists: false,
    agentsMdPath: join(codexHome, 'AGENTS.md'),
    agentsMdExists: existsSync(join(codexHome, 'AGENTS.md')),
    oakSkillsPath: join(codexHome, 'oak-skills'),
    oakSkillsExists: existsSync(join(codexHome, 'oak-skills')),
  };
}

function resolveExistingPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function findGitRepoRoot(start: string | undefined) {
  if (!start) return undefined;
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function commandCheck(command: string, args: string[], optional = false) {
  try {
    const { stdout } = await execFileAsync(resolveCommand(command), args, { timeout: 10_000 });
    return { name: command, status: 'pass' as const, message: stdout.trim().split('\n')[0] ?? `${command} ok` };
  } catch (error) {
    return { name: command, status: optional ? ('warn' as const) : ('fail' as const), message: errorMessage(error).slice(0, 500) };
  }
}

function resolveCommand(command: string) {
  if (process.platform !== 'win32') return command;
  if (command.endsWith('.exe') || command.endsWith('.cmd') || command.endsWith('.bat')) return command;
  return ['npm', 'pnpm', 'yarn', 'bun', 'pm2', 'codex'].includes(command) ? `${command}.cmd` : command;
}

function configureGitSshCommand() {
  if (!GIT_SSH_KEY_PATH || !existsSync(GIT_SSH_KEY_PATH)) return;
  try {
    chmodSync(GIT_SSH_KEY_PATH, 0o600);
  } catch {
    // Some filesystems ignore POSIX modes.
  }
  process.env.GIT_SSH_COMMAND = `ssh -i "${GIT_SSH_KEY_PATH}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
}

async function gitHead(cwd: string) {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd, timeout: 10_000 });
  return stdout.trim();
}

async function agentVersion() {
  const configured = stringValue(process.env.AUTODEVOPS_AGENT_VERSION);
  if (configured) return configured;
  if (BUNDLED_AGENT_VERSION) return BUNDLED_AGENT_VERSION;
  const packagedVersionFile = join(process.cwd(), '.autodevops-version');
  if (existsSync(packagedVersionFile)) return readFileSync(packagedVersionFile, 'utf8').trim() || undefined;
  return gitHead(process.cwd()).catch(() => undefined);
}

async function git(cwd: string, args: string[], timeout = 120_000) {
  await execFileAsync('git', args, { cwd, timeout });
}

async function gitOutput(cwd: string, args: string[], timeout = 120_000) {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout });
  return stdout.trim();
}

async function commitAndPushFixBranch(workspacePath: string, branchName: string, incident: unknown) {
  await ensureGitIdentity(workspacePath);
  const status = await gitOutput(workspacePath, ['status', '--porcelain']);
  if (!status) return { hasChanges: false, pushed: false };
  await git(workspacePath, ['add', '--all']);
  const incidentId = stringValue((incident as { id?: string })?.id) || 'incident';
  await git(workspacePath, ['commit', '-m', `fix: autodevops ${incidentId}`], 180_000);
  await git(workspacePath, ['push', '-u', 'origin', branchName], 180_000);
  return { hasChanges: true, pushed: true, commitSha: await gitHead(workspacePath) };
}

async function ensureGitIdentity(workspacePath: string) {
  const currentEmail = await gitOutput(workspacePath, ['config', '--get', 'user.email']).catch(() => '');
  const currentName = await gitOutput(workspacePath, ['config', '--get', 'user.name']).catch(() => '');
  if (!currentEmail) await git(workspacePath, ['config', 'user.email', process.env.AUTODEVOPS_GIT_EMAIL || 'autodevops-agent@example.local']);
  if (!currentName) await git(workspacePath, ['config', 'user.name', process.env.AUTODEVOPS_GIT_NAME || 'AutoDevOps Agent']);
}

function requireProject(value: unknown): Project {
  if (!value || typeof value !== 'object') throw new Error('project is required in job params');
  const candidate = value as Project;
  if (!candidate.id || !candidate.repositoryUrl) throw new Error('project id and repositoryUrl are required in job params');
  return candidate;
}

function required(value: unknown, name: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function requiredEnv(name: string, fallback: string) {
  return process.env[name] || fallback;
}

function loadPersistentAgentId() {
  const stateDir = resolve(WORKSPACE_ROOT, '..');
  const stateFile = join(stateDir, '.autodevops-agent-id');
  mkdirSync(stateDir, { recursive: true });
  if (existsSync(stateFile)) {
    const existing = readFileSync(stateFile, 'utf8').trim();
    if (existing) return existing;
  }
  const id = newEntityId();
  writeFileSync(stateFile, `${id}\n`, { encoding: 'utf8' });
  return id;
}

function stringValue(value: unknown) {
  return String(value ?? '').trim();
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function looksSecret(key: string) {
  return /(SECRET|TOKEN|PASSWORD|PASS|KEY|DATABASE_URL|DSN|CREDENTIAL)/i.test(key);
}

function truthy(value: unknown) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
