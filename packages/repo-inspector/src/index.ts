import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { v7 as uuidv7 } from 'uuid';
import type { DeployDriver, DeployPackaging, ManagedRuntimeConfigKind, ManagedRuntimeConfigRequirement, OakDetection, Project, RepoInspection, RuntimeContract } from '@zhenfengxx/contracts';

export type { OakDetection, Project, RepoInspection, RuntimeContract } from '@zhenfengxx/contracts';

function newEntityId() {
  return uuidv7();
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

const RUNTIME_CONFIG_DEFINITIONS: ReadonlyArray<{
  kind: ManagedRuntimeConfigKind;
  templatePath: string;
  targetPath: string;
  defaultRequiredAt: ManagedRuntimeConfigRequirement['requiredAt'];
}> = [
  { kind: 'oak_postgres', templatePath: 'configuration/postgres.example.json', targetPath: 'configuration/postgres.json', defaultRequiredAt: 'runtime' },
  { kind: 'oak_mysql', templatePath: 'configuration/mysql.example.json', targetPath: 'configuration/mysql.json', defaultRequiredAt: 'runtime' },
  { kind: 'oak_redis', templatePath: 'configuration/redis.example.json', targetPath: 'configuration/redis.json', defaultRequiredAt: 'runtime' },
];

const DATABASE_CONFIG_CANDIDATES = [
  'configuration/postgres.json',
  'configuration/postgres.dev.json',
  'configuration/postgres.prod.json',
  'configuration/postgres.development.json',
  'configuration/postgres.staging.json',
  'configuration/postgres.production.json',
  'configuration/mysql.json',
  'configuration/mysql.dev.json',
  'configuration/mysql.prod.json',
  'configuration/mysql.development.json',
  'configuration/mysql.staging.json',
  'configuration/mysql.production.json',
];

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
  const oakDatabaseConfigFiles = DATABASE_CONFIG_CANDIDATES.filter((item) => existsSync(join(repositoryPath, item)));
  const runtimeConfigRequirements = inspectRuntimeConfigRequirements(repositoryPath, oakDatabaseConfigFiles);
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
        ...runtimeConfigRequirements.flatMap((item) => item.evidence),
        ...(oakInitializationScript ? [`database-init:${oakInitializationScript}`] : []),
      ],
      databaseConfigFiles: oakDatabaseConfigFiles,
      runtimeConfigRequirements,
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
  const runtimeConfigRequirements = inspection.oak.runtimeConfigRequirements ?? [];
  const databaseConfigurationFiles = runtimeConfigRequirements
    .filter((item) => item.kind === 'oak_postgres' || item.kind === 'oak_mysql')
    .map((item) => item.targetPath);

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
      connectionSource: inspection.oak.detected && databaseConfigurationFiles.length ? 'oak_configuration' : 'unknown',
      configurationFiles: databaseConfigurationFiles.length ? databaseConfigurationFiles : inspection.oak.databaseConfigFiles,
      ...overrides.database,
    },
    runtimeConfig: {
      requirements: runtimeConfigRequirements,
      notes: runtimeConfigRequirements.length
        ? ['Real configuration values are platform-managed; repository example files describe shape only.']
        : [],
      ...overrides.runtimeConfig,
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

function inspectRuntimeConfigRequirements(repositoryPath: string, databaseConfigFiles: string[]): ManagedRuntimeConfigRequirement[] {
  const sourceFiles = collectSourceFiles(join(repositoryPath, 'src'));
  return RUNTIME_CONFIG_DEFINITIONS.flatMap((definition) => {
    const templateExists = existsSync(join(repositoryPath, definition.templatePath));
    const existingRuntimeFile = existsSync(join(repositoryPath, definition.targetPath));
    const relatedDatabaseFile = definition.kind === 'oak_postgres'
      ? databaseConfigFiles.some((item) => item.startsWith('configuration/postgres.')) || databaseConfigFiles.includes(definition.targetPath)
      : definition.kind === 'oak_mysql'
        ? databaseConfigFiles.some((item) => item.startsWith('configuration/mysql.')) || databaseConfigFiles.includes(definition.targetPath)
        : false;
    const staticReference = sourceFiles.find((file) => sourceReferencesPath(file, definition.targetPath));
    if (!templateExists && !existingRuntimeFile && !relatedDatabaseFile && !staticReference) return [];
    const trackedRuntimeFile = gitPathMatches(repositoryPath, ['ls-files', '--error-unmatch', '--', definition.targetPath]);
    const gitIgnored = gitPathMatches(repositoryPath, ['check-ignore', '-q', '--', definition.targetPath]);
    const evidence = [
      ...(templateExists ? [`runtime-config-template:${definition.templatePath}`] : []),
      ...(existingRuntimeFile || relatedDatabaseFile ? [`runtime-config-file:${definition.targetPath}`] : []),
      ...(staticReference ? [`runtime-config-import:${relativeEvidencePath(repositoryPath, staticReference)}`] : []),
      ...(trackedRuntimeFile ? [`runtime-config-tracked:${definition.targetPath}`] : []),
      ...(!gitIgnored ? [`runtime-config-not-ignored:${definition.targetPath}`] : []),
    ];
    return [{
      kind: definition.kind,
      adapterVersion: 1 as const,
      templatePath: templateExists ? definition.templatePath : undefined,
      targetPath: definition.targetPath,
      requiredAt: staticReference ? 'build_and_runtime' as const : definition.defaultRequiredAt,
      required: true,
      evidence,
      templateKeys: templateExists ? readTemplateKeys(join(repositoryPath, definition.templatePath)) : [],
      existingRuntimeFile,
      trackedRuntimeFile,
      gitIgnored,
    }];
  });
}

function collectSourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'es' || entry.name === 'dist') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:[cm]?[jt]sx?)$/i.test(entry.name)) files.push(path);
    }
  };
  visit(root);
  return files;
}

function sourceReferencesPath(file: string, targetPath: string) {
  const normalizedTarget = targetPath.replace(/\\/g, '/');
  const targetName = normalizedTarget.split('/').at(-1) ?? normalizedTarget;
  try {
    const source = readFileSync(file, 'utf8').replace(/\\/g, '/');
    return source.includes(normalizedTarget) || source.includes(`/configuration/${targetName}`) || source.includes(`configuration/${targetName}`);
  }
  catch {
    return false;
  }
}

function readTemplateKeys(path: string): string[] {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.keys(value as Record<string, unknown>).sort();
  }
  catch {
    return [];
  }
}

function gitPathMatches(root: string, args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

function relativeEvidencePath(root: string, path: string) {
  return path.slice(root.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

function userSelectedDeployMode(project: Project): { driver: DeployDriver; packaging: DeployPackaging } | undefined {
  if ((project.automationMode ?? 'deploy') !== 'deploy') return undefined;
  if (project.deployMode === 'pm2_source') return { driver: 'pm2', packaging: 'pm2_source' };
  if (project.deployMode === 'docker_image') return { driver: 'docker', packaging: 'docker_image' };
  return undefined;
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
