import type { Incident, Job, PipelineRun, Project, RepoInspection, RuntimeContract } from '@zhenfengxx/contracts';

export type CodexJsonResult = {
  status: 'success' | 'warning' | 'failed';
  summary: string;
  confidence?: number;
  changedFiles?: string[];
  validation?: Array<{ command: string; status?: string; purpose?: string }>;
  risks?: Array<{ severity: 'low' | 'medium' | 'high'; detail: string }>;
  blockers?: string[];
  recommendedNextAction?: string;
  [key: string]: unknown;
};

export function buildCommandInferencePrompt(input: {
  job: Job;
  project: Project;
  inspection: RepoInspection;
  automationMode: Exclude<NonNullable<Project['automationMode']>, 'fetch_only'>;
  workspacePath: string;
}) {
  return [
    'You are the AutoDevOps repository command inference agent.',
    'This is a read-only inference job. Do not edit files, install packages, run package scripts, restart services, deploy, commit, push, or change remote state.',
    'Infer commands from repository evidence such as package.json scripts, lockfiles, Oak markers, Dockerfiles, PM2 config, and directory layout.',
    'Infer environment configuration requirements from repository evidence. Do not assume the env file is named .env only; inspect references to .env, .env.local, .env.production, config files, README/docs, package scripts, Vite/Node/Oak conventions, process.env usage, dotenv loading, ecosystem files, and deployment scripts.',
    'Oak projects are natively supported: when database configuration is provided by configuration/postgres*.json or configuration/mysql*.json, report that file as repository-managed configuration and do not invent DATABASE_URL or duplicate its connection fields as required environment variables.',
    'The env file name must be treated as a user-confirmed deployment setting. Return candidates and a recommended envFileName, but do not mark it final.',
    'Respect automationMode strictly:',
    '- fetch_install: infer checkout/fetch and dependency installation or lightweight validation commands only. Do not infer deployment commands.',
    '- deploy: infer checkout/fetch, install, code generation, validation, build, and deployment commands when evidence supports them.',
    'Respect user selected deployMode strictly:',
    '- deployMode=pm2_source or deployMode=docker_image is authoritative. Do not change deploy.driver or deploy.packaging. Only infer commands, env files, scripts, ports, health path, and safety notes within the selected deploy mode.',
    '- deployMode=auto means the platform may use repository evidence such as Oak markers or Dockerfiles to choose the deploy mode.',
    '- For fetch_install jobs, deployMode is ignored because no deployment commands may be inferred.',
    'Respect database initialization policy strictly:',
    '- databaseInitMode=skip means the project is assumed to have existing data or initialization is intentionally disabled. Do not infer, recommend, or include seed/init/reset/bootstrap-data commands in checkout/install/build/deploy commands.',
    '- databaseInitMode=init_on_first_deploy means data initialization may be needed only for a brand-new deployment. Infer a candidate dataInitCommand only as separate metadata, mark it high risk, and state that it requires explicit user approval before execution.',
    '- Never mix database migration, seed, reset, or data initialization commands into deployment commands.',
    'If evidence is insufficient, return blockers instead of guessing destructive or production-changing commands.',
    'Return exactly one compact JSON object and no Markdown.',
    '',
    'JSON schema:',
    jsonSchemaText({
      status: 'success|warning|failed',
      summary: 'one concise command inference summary',
      automationMode: 'fetch_install|deploy',
      deployMode: input.project.deployMode ?? 'auto',
      commands: {
        checkout: ['git fetch --all --tags --prune', 'git checkout <ref>'],
        install: ['package-manager install command'],
        codegen: ['safe code generation command'],
        validate: ['check or test command'],
        build: ['build command'],
        deploy: ['deployment command, deploy mode only; no database seed/init/reset commands'],
      },
      database: {
        initMode: input.project.databaseInitMode ?? 'skip',
        migrationCommand: 'candidate migration command as metadata only, or empty string',
        dataInitCommand: 'candidate seed/init command only when init_on_first_deploy, or empty string',
        requiresExplicitApproval: true,
        includeInDeployCommands: false,
      },
      environmentConfig: {
        envFileName: '.env.production|.env.local|.env|custom .env* file name',
        envFileCandidates: ['ordered env file name candidates found or inferred'],
        variables: [
          {
            key: 'ENV_VAR_NAME',
            required: true,
            type: 'string|number|boolean|secret',
            envFile: '.env.production',
            managedBySystem: false,
            defaultValue: 'optional default value',
            description: 'why this variable is required and where it was inferred from',
          },
        ],
        notes: ['ambiguities, files inspected, and variables the user must confirm'],
        requiresUserConfirmation: true,
      },
      validation: [{ command: 'command to run later', purpose: 'what it proves' }],
      risks: [{ severity: 'low|medium|high', detail: 'risk or ambiguity' }],
      blockers: ['missing information preventing safe inference'],
      recommendedNextAction: 'inspect_only|install_dependencies|review_contract|run_pipeline|human_review',
    }),
    '',
    `Payload:\n${JSON.stringify(input, null, 2)}`,
  ].join('\n');
}

export function buildIncidentAnalysisPrompt(input: {
  job: Job;
  incident: Incident;
  pipelineRun?: PipelineRun;
  runtimeContract?: RuntimeContract;
  evidence?: Record<string, unknown>;
  workspacePath?: string;
}) {
  return [
    'You are the AutoDevOps Codex incident analysis agent.',
    'This is a read-only analysis job. Do not edit files, install packages, restart services, deploy, commit, push, or change remote state.',
    'Use Jenkins stage data, Loki/Prometheus summaries, Runtime Contract, and repository evidence to classify the likely cause.',
    'Return exactly one compact JSON object and no Markdown.',
    '',
    'JSON schema:',
    jsonSchemaText({
      status: 'success|warning|failed',
      summary: 'one concise incident summary',
      confidence: 0.0,
      likelyCause: { category: 'env|code|deploy|dependency|infrastructure|unknown', detail: 'specific reason' },
      evidence: [{ source: 'jenkins|loki|prometheus|contract|repo|health', detail: 'short evidence' }],
      recommendedNextAction: 'ignore|rollback|redeploy|config_fix|code_fix|human_review',
      codeFixRequirement: 'requirement for a later fix job, or empty string',
      risks: [{ severity: 'low|medium|high', detail: 'risk or ambiguity' }],
      blockers: ['missing information preventing confident automation'],
    }),
    '',
    `Payload:\n${JSON.stringify(input, null, 2)}`,
  ].join('\n');
}

export function buildFixPlanPrompt(input: {
  job: Job;
  incident: Incident;
  diagnosis?: Record<string, unknown>;
  runtimeContract?: RuntimeContract;
  workspacePath: string;
}) {
  return [
    'You are the AutoDevOps Codex fix planning agent.',
    'This is a read-only planning job. Do not edit files, install packages, restart services, commit, push, or change remote state.',
    'Inspect the workspace only as needed to create a concrete plan.',
    'Return exactly one compact JSON object and no Markdown.',
    '',
    'JSON schema:',
    jsonSchemaText({
      status: 'success|warning|failed',
      summary: 'one concise sentence',
      requirementUnderstanding: 'what must be fixed',
      implementationPlan: ['ordered implementation step'],
      proposedChanges: [{ filePath: 'relative/path', change: 'specific planned edit', reason: 'why' }],
      validation: [{ command: 'command to run', purpose: 'what it proves' }],
      risks: [{ severity: 'low|medium|high', detail: 'risk or ambiguity' }],
      blockers: ['missing information or unsafe condition'],
      recommendedNextAction: 'operator action',
    }),
    '',
    `Payload:\n${JSON.stringify(input, null, 2)}`,
  ].join('\n');
}

export function buildFixApplyPrompt(input: {
  job: Job;
  incident: Incident;
  diagnosis?: Record<string, unknown>;
  runtimeContract?: RuntimeContract;
  workspacePath: string;
  branchName: string;
  baseBranch: string;
  targetBranch: string;
}) {
  return [
    'You are the AutoDevOps Codex fix implementation agent.',
    'This is an approved workspace-write job. Edit files inside the workspace only.',
    'The build agent has already checked out a fix branch from the production base branch. Do not create, switch, merge, or delete branches.',
    'Do not install packages unless explicitly required by the repository, do not restart services, deploy, change production state, commit, push, or merge to the production branch.',
    'The fix branch must be reviewed, validated by pipeline, and explicitly approved by a user before it can be merged to the production target branch.',
    'Make the smallest safe code/config change, then return exactly one compact JSON object and no Markdown.',
    '',
    'JSON schema:',
    jsonSchemaText({
      status: 'success|warning|failed',
      summary: 'one concise sentence about what changed',
      branchPolicy: {
        currentFixBranch: input.branchName,
        baseBranch: input.baseBranch,
        targetBranchAfterApproval: input.targetBranch,
        mergeRequiresUserApproval: true,
      },
      changedFiles: ['relative/path'],
      validation: [{ command: 'command run or recommended', status: 'passed|skipped|failed|not_run', purpose: 'what it proves' }],
      risks: [{ severity: 'low|medium|high', detail: 'risk or ambiguity' }],
      blockers: ['missing information or unsafe condition'],
      recommendedNextAction: 'review_patch|run_pipeline|human_review',
    }),
    '',
    `Payload:\n${JSON.stringify(input, null, 2)}`,
  ].join('\n');
}

export function parseCodexJsonResult(output: string): CodexJsonResult {
  const trimmed = output.trim();
  const direct = tryParseJson(trimmed);
  if (direct) return normalizeResult(direct);
  const match = trimmed.match(/\{[\s\S]*\}/);
  const extracted = match ? tryParseJson(match[0]) : null;
  if (extracted) return normalizeResult(extracted);
  return degradedCodexResult('Codex did not return a parseable JSON object.', { rawOutput: trimmed.slice(-4000) });
}

export function degradedCodexResult(summary: string, extra: Record<string, unknown> = {}): CodexJsonResult {
  return {
    status: 'warning',
    summary,
    confidence: 0,
    risks: [{ severity: 'medium', detail: summary }],
    blockers: ['codex_result_degraded'],
    recommendedNextAction: 'human_review',
    ...extra,
  };
}

export function codexExecutionFailureResult(summary: string, error: unknown): CodexJsonResult {
  const message = sanitizeCodexError(error instanceof Error ? error.message : String(error));
  if (/\b401\b|invalid_api_key|incorrect api key|unauthorized/i.test(message)) {
    return {
      status: 'failed',
      summary: 'Codex authentication failed on the build agent.',
      confidence: 1,
      risks: [{ severity: 'high', detail: 'The build agent cannot call Codex until its API credential is updated.' }],
      blockers: ['codex_authentication_failed'],
      recommendedNextAction: 'configure_codex_credentials',
      error: 'Codex API returned 401 Unauthorized because the configured API key is invalid.',
    };
  }
  return degradedCodexResult(summary, { error: message.slice(-4000) });
}

function sanitizeCodexError(message: string) {
  return message.replace(/\bsk-[A-Za-z0-9_*.-]{8,}/g, '[REDACTED_OPENAI_API_KEY]');
}

function normalizeResult(value: Record<string, unknown>): CodexJsonResult {
  const status = value.status === 'success' || value.status === 'failed' || value.status === 'warning' ? value.status : 'warning';
  return {
    ...value,
    status,
    summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary : 'Codex returned a JSON result without summary.',
  } as CodexJsonResult;
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function jsonSchemaText(value: unknown) {
  return JSON.stringify(value, null, 2);
}
