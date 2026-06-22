import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

export type DeployDriver = 'docker' | 'pm2';
export type DeployPackaging = 'docker_image' | 'pm2_source';
export type ProjectDeployMode = 'auto' | DeployPackaging;
export type ProjectAutomationMode = 'fetch_only' | 'fetch_install' | 'deploy';
export type ProjectActionStatus = 'idle' | JobStatus;
export type DatabaseInitMode = 'skip' | 'init_on_first_deploy';
export type PipelineRunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type IncidentStatus = 'open' | 'analyzing' | 'fix_pending_review' | 'recovered' | 'resolved';
export type CodexFixStatus = 'draft' | 'pending_review' | 'approved' | 'pipeline_running' | 'merge_pending_approval' | 'merge_queued' | 'merged' | 'deployed' | 'rejected';
export type ServerRole = 'platform' | 'build' | 'runtime' | 'observability';
export type AgentStatus = 'online' | 'offline' | 'degraded' | 'disabled';
export type JobStatus = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobType =
  | 'repo.inspect'
  | 'repo.sync'
  | 'repo.install'
  | 'jenkins.pipeline.run'
  | 'codex.incident.analyze'
  | 'codex.fix.create_patch'
  | 'codex.fix.merge_to_production'
  | 'observability.preflight';

export function newEntityId() {
  return uuidv7();
}

export interface Project {
  id: string;
  name: string;
  repositoryUrl: string;
  defaultBranch: string;
  developmentBranch?: string;
  productionBranch?: string;
  environment: string;
  productionServerPath?: string;
  healthPath?: string;
  buildServerId?: string;
  runtimeServerId?: string;
  codeSyncTargetIds?: string[];
  repositoryVisibility?: 'public' | 'private';
  repositoryAuthType?: 'none' | 'ssh_key' | 'token';
  repositoryAuthRef?: string;
  automationMode?: ProjectAutomationMode;
  deployMode?: ProjectDeployMode;
  databaseInitMode?: DatabaseInitMode;
  lastActionId?: string;
  lastActionType?: JobType;
  lastActionStatus?: ProjectActionStatus;
  lastActionJobId?: string;
  lastActionTotalJobs?: number;
  lastActionDoneJobs?: number;
  lastActionError?: string;
  lastActionStartedAt?: string;
  lastActionFinishedAt?: string;
  lastActionUpdatedAt?: string;
  ports?: ProjectPortSummary;
}

export type ProjectPortPurpose = 'backend_runtime' | 'frontend_nginx' | 'docker_host';

export interface ProjectPortBinding {
  purpose: ProjectPortPurpose;
  port: number;
  reservationId: string;
  status: string;
}

export interface ProjectPortSummary {
  authority: 'platform';
  ready: boolean;
  backendRuntime?: ProjectPortBinding;
  frontendNginx?: ProjectPortBinding;
  dockerHost?: ProjectPortBinding;
}

export interface ProjectEnvReview {
  projectId: string;
  environment: string;
  envFileName: string;
  envFileCandidates: string[];
  ready: boolean;
  missingRequiredKeys: string[];
  counts: {
    total: number;
    missing: number;
    systemManaged: number;
    extraUserProvided: number;
    confirmed: number;
  };
  items: Array<{
    key: string;
    required: boolean;
    type: string;
    managedBySystem: boolean;
    envFile?: string;
    status: 'confirmed' | 'missing_value' | 'extra_user_provided' | 'system_managed' | 'optional' | 'conflict';
    description?: string;
    defaultValue?: string;
    hasValue: boolean;
    valuePreview?: string;
    isSecret: boolean;
    valueSource?: string;
    confirmedAt?: string;
  }>;
}

export interface DeploymentPlan {
  projectId: string;
  environment: string;
  ready: boolean;
  deployReady: boolean;
  blockers: Array<{
    code: string;
    message: string;
    action?: string;
  }>;
  confirmationsRequired: string[];
  contract: {
    id?: string;
    status: 'missing' | 'draft' | 'approved';
  };
  pipeline: {
    id?: string;
    status: 'missing' | 'pending' | 'approved';
  };
  planApprovalStatus: 'required' | 'approved';
  server: {
    buildServerId?: string;
    runtimeServerId?: string;
    codeSyncTargetIds?: string[];
    runtimeHost?: string;
  };
  runtime: {
    driver: string;
    packaging: string;
    port?: number;
    serverPath?: string;
    healthPath?: string;
    healthUrl?: string;
    pm2AppName?: string;
    frontendPort?: number;
    dockerHostPort?: number;
    dockerContainerPort?: number;
  };
  port: {
    required: boolean;
    configured: boolean;
    reserved: boolean;
    reservationId?: string;
    conflict?: string;
    suggestedPort?: number;
    authority?: 'platform';
    bindings?: ProjectPortBinding[];
  };
  database: {
    required: boolean;
    configured: boolean;
    initMode: DatabaseInitMode;
    initializationRequired: boolean;
    initializationApprovalStatus: 'not_required' | 'required' | 'approved' | 'reserved' | 'consumed' | 'completed';
  };
  env: ProjectEnvReview;
}

export interface Server {
  id: string;
  name: string;
  role: ServerRole;
  status: 'active' | 'disabled';
  host?: string;
  sshTarget?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'private_key' | 'system_default' | string;
  publicKeyInstalledAt?: string;
  publicKeyFingerprint?: string;
  basePath?: string;
  labels?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface PortReservation {
  id: string;
  serverId: string;
  projectId?: string;
  environment: string;
  port: number;
  protocol: string;
  status: 'reserved' | 'active' | 'released' | string;
  reason?: string;
  metadata?: Record<string, unknown>;
  reservedAt?: string;
  releasedAt?: string;
}

export interface ServerCheck {
  id?: string;
  checkId: string;
  serverId: string;
  status: 'ready' | 'degraded' | 'failed' | 'not_run' | string;
  osFamily?: string;
  osVersion?: string;
  rawOutput?: Record<string, unknown>;
  createdAt?: string;
  items: Array<{
    id?: string;
    name: string;
    status: 'pass' | 'warn' | 'fail' | string;
    version?: string;
    required?: string;
    message?: string;
  }>;
}

export interface ServerProvisioningJob {
  id: string;
  jobId: string;
  serverId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  kind: 'bootstrap' | 'build_agent_install' | 'codex_install' | string;
  component?: string;
  startedAt?: string;
  finishedAt?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentCredentialStatus {
  agentId: string;
  mode: 'per-agent-hmac';
  status: string;
  version: number;
  rotatedAt?: string;
  lastUsedAt?: string;
  hasPreviousSecret: boolean;
}

export interface AgentAuthEvent {
  id: string;
  agentId?: string;
  result: 'succeeded' | 'failed' | string;
  reason?: string;
  method?: string;
  path?: string;
  createdAt?: string;
}

export interface AgentPool {
  id: string;
  name: string;
  description?: string;
  capabilities: string[];
  labels?: Record<string, string>;
}

export interface BuildAgent {
  id: string;
  name: string;
  status: AgentStatus;
  serverId?: string;
  server?: {
    id: string;
    name: string;
    role: string;
    host?: string;
  };
  poolId?: string;
  endpoint?: string;
  capabilities: string[];
  labels?: Record<string, string>;
  readiness?: AgentReadiness;
  runtimeStatus?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  currentJobId?: string;
  version?: string;
  lastHeartbeatAt?: string;
}

export interface AgentReadiness {
  ready: boolean;
  status: 'ready' | 'degraded' | 'blocked';
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message?: string;
  }>;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  targetProjectId?: string;
  sourceType?: string;
  sourceId?: string;
  projectActionId?: string;
  requiredCapabilities: string[];
  params: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  errorSummary?: string;
  requestedBy?: string;
  assignedAgentId?: string;
  pipelineRunId?: string;
  incidentId?: string;
  codexFixId?: string;
  priority: number;
  createdAt?: string;
  acceptedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
}

export interface JobAttempt {
  id: string;
  jobId: string;
  agentId: string;
  attemptNumber: number;
  status: JobStatus;
  agentWorkspacePath?: string;
  resultSummary?: Record<string, unknown>;
  errorSummary?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobEvent {
  id: string;
  jobId: string;
  attemptId?: string;
  agentId?: string;
  type: string;
  status?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export function summarizeProjectActionJobs(jobs: Array<{
  status: JobStatus;
  errorSummary?: string | null;
  cancelReason?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}>) {
  const terminal = new Set<JobStatus>(['succeeded', 'failed', 'cancelled']);
  const doneJobs = jobs.filter((job) => terminal.has(job.status));
  const allTerminal = jobs.length > 0 && doneJobs.length === jobs.length;
  const status: ProjectActionStatus = allTerminal
    ? jobs.some((job) => job.status === 'failed')
      ? 'failed'
      : jobs.some((job) => job.status === 'cancelled')
        ? 'cancelled'
        : 'succeeded'
    : jobs.some((job) => job.status === 'running' || job.status === 'claimed')
      ? 'running'
      : jobs.some((job) => job.status === 'queued')
        ? 'queued'
        : 'idle';
  const errors = jobs
    .filter((job) => job.status === 'failed' || job.status === 'cancelled')
    .map((job) => job.errorSummary ?? job.cancelReason)
    .filter((value): value is string => Boolean(value));
  const startedAt = jobs.map((job) => job.startedAt).filter((value): value is Date => Boolean(value)).sort((a, b) => a.getTime() - b.getTime())[0];
  const finishedAt = allTerminal
    ? jobs.map((job) => job.finishedAt).filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0]
    : undefined;
  return { status, totalJobs: jobs.length, doneJobs: doneJobs.length, error: errors.length ? errors.join('\n') : undefined, startedAt, finishedAt };
}

export interface ClaimedJob {
  job: Job;
  attempt: JobAttempt;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface OakDetection {
  detected: boolean;
  dependencies: string[];
  sourceMarkers: string[];
  scripts: Record<string, string>;
  evidence: string[];
  databaseConfigFiles: string[];
  initializationScript?: string;
}

export interface RepoInspection {
  projectId: string;
  repositoryPath: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  scripts: Record<string, string>;
  dockerfiles: string[];
  pm2Configs: string[];
  oak: OakDetection;
  framework: 'oak' | 'node' | 'unknown';
  recommendedDeploy: {
    driver: DeployDriver;
    packaging: DeployPackaging;
    reason: string;
  };
}

export interface RuntimeContract {
  id: string;
  projectId: string;
  environment: string;
  status: 'draft' | 'approved';
  automationMode: ProjectAutomationMode;
  commandInference?: {
    mode: ProjectAutomationMode;
    status: 'success' | 'warning' | 'failed' | 'skipped';
    summary: string;
    commands?: {
      checkout?: string[];
      install?: string[];
      codegen?: string[];
      validate?: string[];
      build?: string[];
      deploy?: string[];
    };
    validation?: Array<{ command: string; purpose?: string; status?: string }>;
    risks?: Array<{ severity: 'low' | 'medium' | 'high'; detail: string }>;
    blockers?: string[];
  };
  runtime: {
    language: 'node' | 'unknown';
    framework: 'oak' | 'node' | 'unknown';
  };
  build: {
    packageManager: RepoInspection['packageManager'];
    installCommand: string;
    codegenCommands: string[];
    validationCommands: string[];
    frontendBuildCommand?: string;
    frontendDistDir?: string;
  };
  deploy: {
    driver: DeployDriver;
    packaging: DeployPackaging;
    modeSource: 'auto_detected' | 'user_selected';
    environment: string;
    strategy: 'docker_replace' | 'pm2_reload';
    serverPath?: string;
  };
  docker?: {
    dockerfile: string;
    context: string;
    imageRepository: string;
    imageTagTemplate: string;
    containerPort?: number;
    hostPort?: number;
  };
  pm2?: {
    appName: string;
    ecosystemFile: string;
    startCommand: string;
    port?: number;
    envFile?: string;
  };
  network?: {
    authority: 'platform';
    detectedPort?: number;
    backendRuntime?: ProjectPortBinding;
    frontendNginx?: ProjectPortBinding;
    dockerHost?: ProjectPortBinding;
  };
  health: {
    enabled: boolean;
    path?: string;
    url?: string;
  };
  database: {
    initMode: DatabaseInitMode;
    initializeData: boolean;
    migrationCommand?: string;
    dataInitCommand?: string;
    notes: string[];
    connectionSource?: 'oak_configuration' | 'environment' | 'unknown';
    configurationFiles?: string[];
  };
  environmentConfig: {
    envFileName: string;
    envFileCandidates: string[];
    variables: Array<{
      key: string;
      required: boolean;
      type: 'string' | 'number' | 'boolean' | 'secret' | string;
      managedBySystem?: boolean;
      defaultValue?: string;
      description?: string;
      envFile?: string;
    }>;
    notes: string[];
  };
  logs: {
    driver: 'docker' | 'pm2';
    lokiSelector: string;
  };
  requiresApproval: string[];
}

export interface PipelineDefinition {
  id: string;
  projectId: string;
  runtimeContractId: string;
  status: ApprovalStatus;
  deployDriver: DeployDriver;
  deployPackaging: DeployPackaging;
  jenkinsJobName: string;
  jenkinsfile: string;
}

export interface PipelineStage {
  id: string;
  pipelineRunId: string;
  name: string;
  status: PipelineRunStatus;
  startedAt?: string;
  finishedAt?: string;
  logUrl?: string;
  errorSummary?: string;
}

export interface PipelineRun {
  id: string;
  pipelineDefinitionId: string;
  projectId: string;
  jobId?: string;
  status: PipelineRunStatus;
  gitRef: string;
  commitSha?: string;
  jenkinsJobName: string;
  jenkinsBuildNumber?: number;
  jenkinsBuildUrl?: string;
  stages: PipelineStage[];
  resultSummary?: Record<string, unknown>;
}

export interface Release {
  id: string;
  projectId: string;
  version: string;
  commitSha: string;
  deployPackaging: DeployPackaging;
  imageTag?: string;
  imageDigest?: string;
  pm2AppName?: string;
  jenkinsBuildUrl?: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  environment: string;
  releaseId: string;
  status: PipelineRunStatus;
  deployDriver: DeployDriver;
  commitSha: string;
  healthUrl: string;
  serverPath?: string;
  pm2AppName?: string;
  jenkinsBuildUrl?: string;
}

export interface Incident {
  id: string;
  projectId: string;
  environment: string;
  sourceJobId?: string;
  status: IncidentStatus;
  severity: 'warning' | 'critical';
  summary: string;
  source: 'alertmanager' | 'jenkins' | 'manual';
  labels: Record<string, string>;
  evidence: {
    lokiQuery?: string;
    prometheusQuery?: string;
    startsAt?: string;
    endsAt?: string;
    excerpt?: string;
  };
}

export interface CodexFix {
  id: string;
  incidentId: string;
  projectId: string;
  sourceJobId?: string;
  status: CodexFixStatus;
  diagnosis: string;
  fixType: 'config_fix' | 'code_fix' | 'pipeline_fix' | 'external_dependency';
  branchName?: string;
  baseBranch?: string;
  targetBranch?: string;
  pullRequestUrl?: string;
  pipelineRunId?: string;
}

export function requiredCapabilitiesForJob(type: JobType): string[] {
  if (type === 'repo.inspect') return ['repo.inspect'];
  if (type === 'repo.sync') return ['repo.sync'];
  if (type === 'repo.install') return ['repo.sync'];
  if (type === 'jenkins.pipeline.run') return ['jenkins.run'];
  if (type === 'codex.incident.analyze') return ['codex.exec', 'incident.analyze'];
  if (type === 'codex.fix.create_patch') return ['codex.exec', 'codex.fix'];
  if (type === 'codex.fix.merge_to_production') return ['repo.write'];
  return ['observability.preflight'];
}

export function requiredCapabilitiesForProjectInspection(project: Pick<Project, 'automationMode'>): string[] {
  return project.automationMode === 'fetch_only' ? ['repo.inspect'] : ['repo.inspect', 'codex.exec'];
}

export function generateCodexFixBranchName(input: { projectId: string; incidentId: string; fixId: string }) {
  return `autodevops/fix/${gitBranchSegment(input.projectId)}/${gitBranchSegment(input.incidentId)}/${gitBranchSegment(input.fixId).slice(-12)}`;
}

function gitBranchSegment(value: string) {
  const segment = String(value || 'unknown')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.+$/g, '');
  return segment || 'unknown';
}

export function agentCanRunJob(agent: Pick<BuildAgent, 'status' | 'capabilities'>, job: Pick<Job, 'requiredCapabilities'>): boolean {
  if (agent.status !== 'online' && agent.status !== 'degraded') return false;
  const capabilities = new Set(agent.capabilities);
  return job.requiredCapabilities.every((capability) => capabilities.has(capability));
}

export interface JenkinsBuildWebhook {
  pipelineRunId?: string;
  jobName: string;
  buildNumber: number;
  buildUrl: string;
  status: 'STARTED' | 'SUCCESS' | 'FAILURE' | 'ABORTED';
  gitRef?: string;
  commitSha?: string;
  stages?: Array<{
    name: string;
    status: 'SUCCESS' | 'FAILURE' | 'IN_PROGRESS' | 'ABORTED';
    startedAt?: string;
    finishedAt?: string;
    logUrl?: string;
    errorSummary?: string;
  }>;
  release?: {
    version?: string;
    imageTag?: string;
    imageDigest?: string;
    pm2AppName?: string;
    healthUrl?: string;
    serverPath?: string;
  };
}

export const OAK_DEPENDENCIES = [
  '@xuchangzju/oak-cli',
  'oak-cli',
  'oak-domain',
  'oak-frontend-base',
  'oak-backend-base',
  'oak-general-business',
  'oak-pay-business',
  '@oak-frontend-base',
  '@oak-backend-base',
  '@oak-general-business',
  '@oak-pay-business',
];

export const OAK_SOURCE_MARKERS = [
  'src/entities',
  'src/oak-app-domain',
  'src/aspects',
  'src/endpoints',
  'src/triggers',
  'src/watchers',
  'src/timers',
  'src/features',
  'src/pages',
  'src/components',
];

export const OAK_CODEGEN_SCRIPT_ORDER = ['project:init', 'make:domain', 'make:locale', 'make:dep'];
export const OAK_VALIDATION_SCRIPT_ORDER = ['check', 'build:lib', 'build:es'];

export function inspectRepository(projectId: string, repositoryPath: string): RepoInspection {
  const packageJson = readPackageJson(repositoryPath);
  const scripts = normalizeScripts(packageJson?.scripts);
  const packageManager = detectPackageManager(repositoryPath, packageJson);
  const dependencies = collectDependencies(packageJson);
  const oakDependencyMatches = dependencies.filter((name) => OAK_DEPENDENCIES.includes(name) || name.includes('oak-'));
  const oakSourceMarkers = OAK_SOURCE_MARKERS.filter((marker) => existsSync(join(repositoryPath, marker)));
  const oakScriptNames = [...OAK_CODEGEN_SCRIPT_ORDER, 'build:lib', 'build:es'];
  const oakScripts = Object.fromEntries(
    Object.entries(scripts).filter(([name, command]) => oakScriptNames.includes(name) || command.includes('oak-cli') || command.includes('@oak-app-domain')),
  );
  const oakDetected = oakDependencyMatches.length > 0 || oakSourceMarkers.length > 0 || Object.keys(oakScripts).length > 0;
  const dockerfiles = ['Dockerfile', 'docker/Dockerfile'].filter((item) => existsSync(join(repositoryPath, item)));
  const pm2Configs = ['ecosystem.config.js', 'ecosystem.config.cjs', 'ecosystem.config.mjs', 'ecosystem.json'].filter((item) =>
    existsSync(join(repositoryPath, item)),
  );
  const oakDatabaseConfigFiles = [
    'configuration/postgres.json',
    'configuration/postgres.dev.json',
    'configuration/postgres.prod.json',
    'configuration/mysql.json',
    'configuration/mysql.dev.json',
    'configuration/mysql.prod.json',
  ].filter((item) => existsSync(join(repositoryPath, item)));
  const oakInitializationScript = existsSync(join(repositoryPath, 'scripts/initServer.js')) ? 'scripts/initServer.js' : undefined;

  return {
    projectId,
    repositoryPath,
    packageManager,
    scripts,
    dockerfiles,
    pm2Configs,
    oak: {
      detected: oakDetected,
      dependencies: oakDependencyMatches,
      sourceMarkers: oakSourceMarkers,
      scripts: oakScripts,
      evidence: [
        ...oakDependencyMatches.map((item) => `dependency:${item}`),
        ...oakSourceMarkers.map((item) => `source:${item}`),
        ...Object.keys(oakScripts).map((item) => `script:${item}`),
        ...oakDatabaseConfigFiles.map((item) => `database-config:${item}`),
        ...(oakInitializationScript ? [`database-init:${oakInitializationScript}`] : []),
      ],
      databaseConfigFiles: oakDatabaseConfigFiles,
      initializationScript: oakInitializationScript,
    },
    framework: oakDetected ? 'oak' : packageJson ? 'node' : 'unknown',
    recommendedDeploy: oakDetected
      ? {
          driver: 'pm2',
          packaging: 'pm2_source',
          reason: 'Oak/Node business repositories default to PM2 source deploy to avoid repeated image rebuilds.',
        }
      : dockerfiles.length
        ? {
            driver: 'docker',
            packaging: 'docker_image',
            reason: 'Dockerfile detected and Oak markers are absent.',
          }
        : {
            driver: 'pm2',
            packaging: 'pm2_source',
            reason: 'Node repository without Dockerfile falls back to PM2 source deploy.',
          },
  };
}

export function createRuntimeContract(project: Project, inspection: RepoInspection, overrides: Partial<RuntimeContract> = {}): RuntimeContract {
  const userSelectedDeploy = userSelectedDeployMode(project);
  const deployDriver = userSelectedDeploy?.driver ?? overrides.deploy?.driver ?? inspection.recommendedDeploy.driver;
  const packaging = userSelectedDeploy?.packaging ?? overrides.deploy?.packaging ?? (deployDriver === 'docker' ? 'docker_image' : 'pm2_source');
  const modeSource = userSelectedDeploy ? 'user_selected' : (overrides.deploy?.modeSource ?? 'auto_detected');
  const script = (name: string) => scriptCommand(inspection.packageManager, name);
  const codegenCommands = inspection.oak.detected
    ? OAK_CODEGEN_SCRIPT_ORDER.filter((name) => inspection.scripts[name]).map(script)
    : [];
  const validationCommands = OAK_VALIDATION_SCRIPT_ORDER.filter((name) => inspection.scripts[name]).map(script);
  const fallbackValidation = validationCommands.length ? validationCommands : inspection.scripts.test ? [script('test')] : [];
  const frontendBuildCommand = inspection.scripts.build ? script('build') : undefined;
  const healthPath = project.healthPath;

  return {
    id: overrides.id ?? newEntityId(),
    projectId: project.id,
    environment: project.environment,
    status: overrides.status ?? 'draft',
    automationMode: project.automationMode ?? overrides.automationMode ?? 'deploy',
    commandInference: overrides.commandInference,
    runtime: {
      language: 'node',
      framework: inspection.framework,
      ...overrides.runtime,
    },
    build: {
      packageManager: inspection.packageManager,
      installCommand: installCommand(inspection.packageManager),
      codegenCommands,
      validationCommands: fallbackValidation,
      frontendBuildCommand,
      frontendDistDir: frontendBuildCommand ? 'dist' : undefined,
      ...overrides.build,
    },
    deploy: {
      ...overrides.deploy,
      driver: deployDriver,
      packaging,
      modeSource,
      environment: project.environment,
      strategy: deployDriver === 'docker' ? 'docker_replace' : 'pm2_reload',
      serverPath: project.productionServerPath,
    },
    docker:
      deployDriver === 'docker'
        ? {
            dockerfile: inspection.dockerfiles[0] || 'Dockerfile',
            context: '.',
            imageRepository: project.id,
            imageTagTemplate: `${project.id}:\${VERSION}-\${COMMIT_SHA}`,
            ...overrides.docker,
          }
        : undefined,
    pm2:
      deployDriver === 'pm2'
        ? {
            appName: project.id,
            ecosystemFile: inspection.pm2Configs[0] || 'ecosystem.config.js',
            startCommand: inspection.scripts['server:start'] ? script('server:start') : inspection.scripts.start ? script('start') : 'npm run start',
            ...overrides.pm2,
          }
        : undefined,
    health: {
      enabled: Boolean(healthPath),
      path: healthPath,
      ...overrides.health,
    },
    database: {
      initMode: project.databaseInitMode ?? 'skip',
      initializeData: project.databaseInitMode === 'init_on_first_deploy',
      dataInitCommand:
        project.databaseInitMode === 'init_on_first_deploy' && inspection.oak.detected && inspection.oak.initializationScript
          ? `NODE_ENV=production OAK_PLATFORM=server node ${inspection.oak.initializationScript}`
          : undefined,
      notes:
        project.databaseInitMode === 'init_on_first_deploy'
          ? ['Data initialization is intended only for first deployment and still requires explicit user approval before execution.']
          : ['Data initialization is disabled by default. Do not infer or run seed/init/reset commands during deployment.'],
      connectionSource: inspection.oak.detected && inspection.oak.databaseConfigFiles.length ? 'oak_configuration' : 'unknown',
      configurationFiles: inspection.oak.databaseConfigFiles,
      ...overrides.database,
    },
    environmentConfig: {
      envFileName: '.env.production',
      envFileCandidates: ['.env.production', '.env.local', '.env'],
      variables: [],
      notes: ['Environment variable names and env file name must be reviewed and confirmed by the user before deployment.'],
      ...overrides.environmentConfig,
    },
    logs: {
      driver: deployDriver === 'docker' ? 'docker' : 'pm2',
      lokiSelector: `{project="${project.id}",environment="${project.environment}"}`,
      ...overrides.logs,
    },
    requiresApproval: [
      'runtime_contract.activate',
      ...(deployDriver === 'pm2' ? ['pm2.production_server_path', 'pm2.start_command'] : ['docker.image_repository']),
      ...(project.databaseInitMode === 'init_on_first_deploy' ? ['database.initialize_data'] : []),
      ...(overrides.requiresApproval ?? []),
    ],
  };
}

function userSelectedDeployMode(project: Project): { driver: DeployDriver; packaging: DeployPackaging } | undefined {
  if ((project.automationMode ?? 'deploy') !== 'deploy') return undefined;
  if (project.deployMode === 'pm2_source') return { driver: 'pm2', packaging: 'pm2_source' };
  if (project.deployMode === 'docker_image') return { driver: 'docker', packaging: 'docker_image' };
  return undefined;
}

export function mapJenkinsStatus(status: JenkinsBuildWebhook['status']): PipelineRunStatus {
  if (status === 'SUCCESS') return 'success';
  if (status === 'FAILURE') return 'failed';
  if (status === 'ABORTED') return 'cancelled';
  return 'running';
}

export function mapJenkinsStageStatus(status: NonNullable<JenkinsBuildWebhook['stages']>[number]['status']): PipelineRunStatus {
  if (status === 'SUCCESS') return 'success';
  if (status === 'FAILURE') return 'failed';
  if (status === 'ABORTED') return 'cancelled';
  return 'running';
}

export function applyJenkinsWebhook(run: PipelineRun, webhook: JenkinsBuildWebhook): PipelineRun {
  return {
    ...run,
    status: mapJenkinsStatus(webhook.status),
    commitSha: webhook.commitSha ?? run.commitSha,
    gitRef: webhook.gitRef ?? run.gitRef,
    jenkinsBuildNumber: webhook.buildNumber,
    jenkinsBuildUrl: webhook.buildUrl,
    stages: (webhook.stages ?? []).map((stage, index) => ({
      id: newEntityId(),
      pipelineRunId: run.id,
      name: stage.name,
      status: mapJenkinsStageStatus(stage.status),
      startedAt: stage.startedAt,
      finishedAt: stage.finishedAt,
      logUrl: stage.logUrl,
      errorSummary: stage.errorSummary,
    })),
    resultSummary: {
      ...(run.resultSummary ?? {}),
      release: webhook.release ?? null,
    },
  };
}

function readPackageJson(root: string): Record<string, unknown> | null {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function normalizeScripts(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function collectDependencies(packageJson: Record<string, unknown> | null): string[] {
  if (!packageJson) return [];
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const names = new Set<string>();
  for (const section of sections) {
    const deps = packageJson[section];
    if (deps && typeof deps === 'object') {
      Object.keys(deps).forEach((name) => names.add(name));
    }
  }
  return [...names].sort();
}

function detectPackageManager(root: string, packageJson: Record<string, unknown> | null): RepoInspection['packageManager'] {
  const packageManager = typeof packageJson?.packageManager === 'string' ? packageJson.packageManager : '';
  if (packageManager.startsWith('pnpm')) return 'pnpm';
  if (packageManager.startsWith('yarn')) return 'yarn';
  if (packageManager.startsWith('bun')) return 'bun';
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function installCommand(packageManager: RepoInspection['packageManager']): string {
  if (packageManager === 'pnpm') return 'pnpm install --frozen-lockfile';
  if (packageManager === 'yarn') return 'yarn install --frozen-lockfile';
  if (packageManager === 'bun') return 'bun install --frozen-lockfile';
  return 'npm ci';
}

function scriptCommand(packageManager: RepoInspection['packageManager'], name: string): string {
  if (packageManager === 'pnpm') return `pnpm run ${name}`;
  if (packageManager === 'yarn') return `yarn ${name}`;
  if (packageManager === 'bun') return `bun run ${name}`;
  return `npm run ${name}`;
}
