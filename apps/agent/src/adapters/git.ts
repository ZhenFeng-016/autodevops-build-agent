import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Project } from '@zhenfengxx/contracts';
import { commandErrorOutput, isJobExecutionCancelled, stringValue } from '../common.js';
import type { AgentConfig } from '../config.js';
import { execFileWithProcessTree } from '../process-execution.js';
import { withTransientGitRetry } from '../transient-git-retry.js';

export interface GitAdapter {
  syncWorkspace(project: Project, gitRef: string, targetPath?: string, signal?: AbortSignal): Promise<string>;
  installDependencies(cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  checkoutBranch(cwd: string, branchName: string, baseCommitSha: string, signal?: AbortSignal): Promise<void>;
  commitAndPushFix(cwd: string, branchName: string, incident: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
  mergeAndPush(cwd: string, branchName: string, targetBranch: string, signal?: AbortSignal): Promise<string>;
  head(cwd: string, signal?: AbortSignal): Promise<string>;
}

export class SystemGitAdapter implements GitAdapter {
  constructor(private readonly config: AgentConfig) {}

  async syncWorkspace(project: Project, gitRef: string, targetPath = resolve(this.config.workspaceRoot, project.id), signal?: AbortSignal) {
    assertInsideWorkspace(this.config.workspaceRoot, targetPath);
    mkdirSync(this.config.workspaceRoot, { recursive: true });
    if (!existsSync(join(targetPath, '.git'))) {
      await this.runWithTransientGitRetry('git', ['clone', '--no-checkout', project.repositoryUrl, targetPath], { timeout: 180_000, signal });
    } else {
      await this.run(targetPath, ['remote', 'set-url', 'origin', project.repositoryUrl], 30_000, signal);
    }
    await this.runWithTransientGitRetry('git', ['fetch', 'origin', '--tags', '--prune'], { cwd: targetPath, timeout: 180_000, signal });
    const commitSha = await this.resolveFetchedCommit(targetPath, gitRef, signal);
    await this.run(targetPath, ['checkout', '--detach', commitSha], 60_000, signal);
    await this.run(targetPath, ['reset', '--hard', commitSha], 60_000, signal);
    await this.run(targetPath, ['clean', '-fd'], 60_000, signal);
    if (resolve(targetPath) === resolve(this.config.workspaceRoot, project.id)) {
      materializeWorkspaceAlias(this.config.workspaceRoot, project.name, targetPath);
    }
    return targetPath;
  }

  async installDependencies(cwd: string, timeoutMs: number, signal?: AbortSignal) {
    return this.installDependenciesRecursive(cwd, timeoutMs, new Set<string>(), signal);
  }

  private async installDependenciesRecursive(cwd: string, timeoutMs: number, visited: Set<string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const canonicalPath = realpathSync(cwd);
    assertInsideWorkspace(this.config.workspaceRoot, canonicalPath);
    if (visited.has(canonicalPath)) return { skipped: true, reason: 'Local file dependency already prepared' };
    visited.add(canonicalPath);

    const localDependencies = localFileDependencyPaths(canonicalPath, this.config.workspaceRoot);
    const preparedLocalDependencies: Array<{ path: string; install: Record<string, unknown> }> = [];
    for (const dependencyPath of localDependencies) {
      preparedLocalDependencies.push({
        path: dependencyPath,
        install: await this.installDependenciesRecursive(dependencyPath, timeoutMs, visited, signal),
      });
    }

    const install = await this.installCurrentDirectory(canonicalPath, timeoutMs, signal);
    return localDependencies.length ? { ...install, preparedLocalDependencies } : install;
  }

  private async installCurrentDirectory(cwd: string, timeoutMs: number, signal?: AbortSignal) {
    const npmLockTracked = existsSync(join(cwd, 'package-lock.json')) && (await this.fileIsTracked(cwd, 'package-lock.json', signal));
    const command = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : npmLockTracked ? 'npm' : existsSync(join(cwd, 'yarn.lock')) ? 'yarn' : existsSync(join(cwd, 'package.json')) ? 'npm' : '';
    if (!command) return { skipped: true, reason: 'No package.json found' };
    if (command === 'npm' && !npmLockTracked) rmSync(join(cwd, 'package-lock.json'), { force: true });
    const args = command === 'pnpm'
      ? ['install', '--frozen-lockfile', '--prod=false']
      : command === 'yarn'
        ? ['install', '--frozen-lockfile', '--production=false']
        : npmLockTracked
          ? ['ci', '--include=dev']
          : ['install', '--include=dev', '--package-lock=false'];
    const env = { ...process.env, NODE_ENV: 'development', npm_config_omit: '' };
    if (command === 'npm' && shouldIsolateOakDependencyScripts(readManifest(cwd))) {
      const isolatedArgs = [...args, '--legacy-peer-deps', '--ignore-scripts'];
      const { stdout, stderr } = await this.runWithTransientGitRetry(command, isolatedArgs, { cwd, timeout: timeoutMs, env, signal });
      const rootPostinstall = await this.runRootPostinstall(cwd, timeoutMs, env, signal);
      return {
        ...installResult(command, isolatedArgs, stdout, stderr, true, false),
        dependencyScriptsSkipped: true,
        rootPostinstall,
        fallbackReason: 'Oak Git dependencies use development-time sibling file references; dependency lifecycle scripts were isolated.',
      };
    }
    try {
      const { stdout, stderr } = await this.runWithTransientGitRetry(command, args, { cwd, timeout: timeoutMs, env, signal });
      return installResult(command, args, stdout, stderr, false, false);
    } catch (error) {
      const output = commandErrorOutput(error);
      if (command !== 'npm') throw error;
      if (args[0] === 'ci' && /can only install packages when[\s\S]*in sync/i.test(output)) {
        const installArgs = ['install', '--include=dev', '--package-lock=false'];
        try {
          const { stdout, stderr } = await this.runWithTransientGitRetry(command, installArgs, { cwd, timeout: timeoutMs, env, signal });
          return { ...installResult(command, installArgs, stdout, stderr, false, true), fallbackReason: 'Committed npm lockfile is out of sync with package.json.' };
        } catch (installError) {
          if (!/\bERESOLVE\b/.test(commandErrorOutput(installError))) throw installError;
          const fallbackArgs = [...installArgs, '--legacy-peer-deps'];
          const { stdout, stderr } = await this.runWithTransientGitRetry(command, fallbackArgs, { cwd, timeout: timeoutMs, env, signal });
          return { ...installResult(command, fallbackArgs, stdout, stderr, true, true), fallbackReason: 'Committed npm lockfile is out of sync and strict peer dependency resolution failed.' };
        }
      }
      if (!/\bERESOLVE\b/.test(output)) throw error;
      const fallbackArgs = [...args, '--legacy-peer-deps'];
      const { stdout, stderr } = await this.runWithTransientGitRetry(command, fallbackArgs, { cwd, timeout: timeoutMs, env, signal });
      return { ...installResult(command, fallbackArgs, stdout, stderr, true, false), fallbackReason: 'Strict npm dependency resolution failed with ERESOLVE.' };
    }
  }

  private async runRootPostinstall(cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
    const scripts = objectRecord(readManifest(cwd).scripts);
    if (typeof scripts.postinstall !== 'string' || !scripts.postinstall.trim()) {
      return { skipped: true, reason: 'No root postinstall script found.' };
    }
    const args = ['run', 'postinstall'];
    const { stdout, stderr } = await execFileWithProcessTree('npm', args, { cwd, timeout: timeoutMs, env, signal });
    return installResult('npm', args, stdout, stderr, false, false);
  }

  private async runWithTransientGitRetry(
    command: string,
    args: string[],
    options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
  ) {
    const packageManagerCommand = command === 'npm' || command === 'pnpm' || command === 'yarn';
    return withTransientGitRetry(
      () => packageManagerCommand
        ? execFileWithProcessTree(command, args, options)
        : execFileWithProcessTree(command, args, options),
      {
        onRetry: ({ attempt, nextAttempt, delayMs }) => {
          console.warn(`Transient Git/SSH failure while running ${command}; retrying attempt ${nextAttempt}/3 after ${delayMs}ms (attempt ${attempt} failed).`);
        },
        signal: options.signal,
      },
    );
  }

  async checkoutBranch(cwd: string, branchName: string, baseCommitSha: string, signal?: AbortSignal) {
    const resolvedBaseCommitSha = await this.output(cwd, ['rev-parse', '--verify', `${baseCommitSha}^{commit}`], 120_000, signal);
    await this.run(cwd, ['checkout', '-B', branchName, resolvedBaseCommitSha], 120_000, signal);
  }

  async commitAndPushFix(cwd: string, branchName: string, incident: unknown, signal?: AbortSignal) {
    await this.ensureIdentity(cwd, signal);
    const status = await this.output(cwd, ['status', '--porcelain'], 120_000, signal);
    if (!status) return { hasChanges: false, pushed: false };
    await this.run(cwd, ['add', '--all'], 120_000, signal);
    const incidentId = stringValue((incident as { id?: string })?.id) || 'incident';
    await this.run(cwd, ['commit', '-m', `fix: autodevops ${incidentId}`], 180_000, signal);
    await this.run(cwd, ['push', '-u', 'origin', branchName], 180_000, signal);
    return { hasChanges: true, pushed: true, commitSha: await this.head(cwd, signal) };
  }

  async mergeAndPush(cwd: string, branchName: string, targetBranch: string, signal?: AbortSignal) {
    await this.runWithTransientGitRetry('git', ['fetch', 'origin', '--tags', '--prune'], { cwd, timeout: 180_000, signal });
    const targetCommitSha = await this.resolveFetchedCommit(cwd, targetBranch, signal);
    const fixCommitSha = await this.resolveFetchedCommit(cwd, branchName, signal);
    await this.run(cwd, ['checkout', '-B', targetBranch, targetCommitSha], 120_000, signal);
    await this.run(cwd, ['reset', '--hard', targetCommitSha], 120_000, signal);
    await this.run(cwd, ['merge', '--no-ff', fixCommitSha, '-m', `Merge ${branchName} into ${targetBranch}`], 180_000, signal);
    await this.run(cwd, ['push', 'origin', `HEAD:refs/heads/${targetBranch}`], 180_000, signal);
    return this.head(cwd, signal);
  }

  head(cwd: string, signal?: AbortSignal) {
    return this.output(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 120_000, signal);
  }

  private async run(cwd: string, args: string[], timeout = 120_000, signal?: AbortSignal) {
    await execFileWithProcessTree('git', args, { cwd, timeout, signal });
  }

  private async output(cwd: string, args: string[], timeout = 120_000, signal?: AbortSignal) {
    const { stdout } = await execFileWithProcessTree('git', args, { cwd, timeout, signal });
    return stdout.trim();
  }

  private async resolveFetchedCommit(cwd: string, gitRef: string, signal?: AbortSignal) {
    const branchName = gitRef.replace(/^refs\/remotes\/origin\//, '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');
    const tagName = gitRef.replace(/^refs\/tags\//, '');
    const candidates = [`refs/remotes/origin/${branchName}`, `refs/tags/${tagName}`, gitRef];
    for (const candidate of new Set(candidates)) {
      const commitSha = await this.output(cwd, ['rev-parse', '--verify', `${candidate}^{commit}`], 120_000, signal).catch((error) => {
        if (isJobExecutionCancelled(error)) throw error;
        return '';
      });
      if (/^[0-9a-f]{40,64}$/i.test(commitSha)) return commitSha.toLowerCase();
    }
    throw new Error(`Git ref was not found after fetching origin: ${gitRef}`);
  }

  private async fileIsTracked(cwd: string, path: string, signal?: AbortSignal) {
    try {
      await execFileWithProcessTree('git', ['ls-files', '--error-unmatch', '--', path], { cwd, timeout: 10_000, signal });
      return true;
    } catch (error) {
      if (isJobExecutionCancelled(error)) throw error;
      return false;
    }
  }

  private async ensureIdentity(cwd: string, signal?: AbortSignal) {
    const currentEmail = await this.output(cwd, ['config', '--get', 'user.email'], 120_000, signal).catch((error) => {
      if (isJobExecutionCancelled(error)) throw error;
      return '';
    });
    const currentName = await this.output(cwd, ['config', '--get', 'user.name'], 120_000, signal).catch((error) => {
      if (isJobExecutionCancelled(error)) throw error;
      return '';
    });
    if (!currentEmail) await this.run(cwd, ['config', 'user.email', process.env.AUTODEVOPS_GIT_EMAIL || 'autodevops-agent@example.local'], 120_000, signal);
    if (!currentName) await this.run(cwd, ['config', 'user.name', process.env.AUTODEVOPS_GIT_NAME || 'AutoDevOps Agent'], 120_000, signal);
  }
}

export function shouldIsolateOakDependencyScripts(manifest: Record<string, unknown>) {
  const oak = objectRecord(manifest.oak);
  const devDependencies = objectRecord(manifest.devDependencies);
  const cliSpecifier = devDependencies['@xuchangzju/oak-cli'];
  return Object.keys(oak).length > 0
    && typeof cliSpecifier === 'string'
    && /^(?:git\+ssh|git\+https|ssh:|git@)/i.test(cliSpecifier);
}

function readManifest(cwd: string) {
  return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function materializeWorkspaceAlias(workspaceRoot: string, projectName: string, targetPath: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectName) || projectName === '.' || projectName === '..') {
    throw new Error(`Project name cannot be used as a workspace alias: ${projectName}`);
  }
  assertInsideWorkspace(workspaceRoot, targetPath);
  const aliasPath = resolve(workspaceRoot, projectName);
  assertInsideWorkspace(workspaceRoot, aliasPath);
  if (aliasPath === resolve(targetPath)) return aliasPath;

  if (existsSync(aliasPath)) {
    const entry = lstatSync(aliasPath);
    if (entry.isSymbolicLink() && realpathSync(aliasPath) === realpathSync(targetPath)) return aliasPath;
    throw new Error(`Workspace alias already exists and does not point to this project: ${projectName}`);
  }

  symlinkSync(resolve(targetPath), aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
  return aliasPath;
}

export function localFileDependencyPaths(cwd: string, workspaceRoot: string) {
  const manifestPath = join(cwd, 'package.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies']
    .map((key) => manifest[key])
    .filter((group): group is Record<string, unknown> => Boolean(group && typeof group === 'object' && !Array.isArray(group)));
  const paths = new Set<string>();
  for (const group of dependencyGroups) {
    for (const specifier of Object.values(group)) {
      if (typeof specifier !== 'string' || !specifier.startsWith('file:')) continue;
      const candidate = resolve(cwd, specifier.slice('file:'.length));
      if (!existsSync(join(candidate, 'package.json'))) continue;
      const canonicalPath = realpathSync(candidate);
      assertInsideWorkspace(workspaceRoot, canonicalPath);
      paths.add(canonicalPath);
    }
  }
  return [...paths].sort();
}

function assertInsideWorkspace(workspaceRoot: string, targetPath: string) {
  const relativePath = relative(resolve(workspaceRoot), resolve(targetPath));
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new Error('Workspace path escaped agent workspace root');
  }
}

function installResult(command: string, args: string[], stdout: string, stderr: string, peerDependencyFallback: boolean, lockfileFallback: boolean) {
  return {
    command: [command, ...args].join(' '),
    stdout: stdout.slice(-4000),
    stderr: stderr.slice(-4000),
    peerDependencyFallback,
    lockfileFallback,
  };
}
