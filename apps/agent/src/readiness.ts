import { execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentReadiness } from '@zhenfengxx/contracts';
import type { AgentConfig } from './config.js';
import { errorMessage } from './common.js';
import { gitHead, versionInfo } from './identity.js';

const execFileAsync = promisify(execFile);

export class ReadinessService {
  constructor(private readonly config: AgentConfig) {}

  async build(): Promise<AgentReadiness> {
    const skillStatus = await this.codexSkills();
    const checks = [
      await commandCheck('git', ['--version']),
      await commandCheck('node', ['--version']),
      await commandCheck('npm', ['--version']),
      await commandCheck('pnpm', ['--version'], true),
      await commandCheck('docker', ['--version'], true),
      await commandCheck(this.config.codexCli, ['--version'], true),
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

  async runtimeStatus() {
    return {
      hostname: hostname(),
      pid: process.pid,
      workspaceRoot: this.config.workspaceRoot,
      nodeVersion: process.version,
      serviceManager: this.config.serviceManager,
    };
  }

  async diagnostics() {
    return {
      version: await versionInfo(),
      agentId: this.config.agentId,
      apiBaseUrl: this.config.apiBaseUrl,
      readiness: await this.build(),
      runtime: await this.runtimeStatus(),
      codexSkills: await this.codexSkills(),
    };
  }

  async codexSkills() {
    const codexHome = process.env.CODEX_HOME || join(process.env.HOME || '', '.codex');
    const oakFramework = await inspectOakFrameworkSkill(codexHome);
    return {
      codexHome,
      oakFrameworkAvailable: oakFramework.available,
      oakFramework,
    };
  }
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

async function commandCheck(command: string, args: string[], optional = false) {
  try {
    const resolved = resolveCommand(command);
    const windowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
    const executable = windowsScript ? process.env.ComSpec || 'cmd.exe' : resolved;
    const commandArgs = windowsScript ? ['/d', '/s', '/c', resolved, ...args] : args;
    const { stdout } = await execFileAsync(executable, commandArgs, { timeout: 10_000 });
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
