import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Project } from '@zhenfengxx/contracts';
import { isLoopbackHost, shellQuote, splitShellWords, type CommandResult, type TargetServer } from '../common.js';
import type { AgentConfig } from '../config.js';

export interface RemoteAdapter {
  syncProject(project: Project, server: TargetServer, gitRef: string, install: boolean, timeoutMs: number): Promise<CommandResult & { targetPath: string }>;
  targetPath(project: Project, server: TargetServer): string;
  isLocal(server: TargetServer): boolean;
}

export class SshRemoteAdapter implements RemoteAdapter {
  constructor(private readonly config: AgentConfig) {}

  async syncProject(project: Project, server: TargetServer, gitRef: string, install: boolean, timeoutMs: number) {
    const targetPath = this.targetPath(project, server);
    const script = `${repoSyncScript(project.repositoryUrl, gitRef, targetPath, this.config.gitSshKeyPath)}${install ? `\n${repoInstallScript(targetPath)}` : ''}`;
    return { ...(await this.run(server, script, timeoutMs)), targetPath };
  }

  targetPath(project: Project, server: TargetServer) {
    if (this.isLocal(server)) return `${this.config.workspaceRoot}/${project.id}`;
    const basePath = (server.basePath || '/opt/autodevops').replace(/\/$/, '');
    if (server.role === 'runtime') return project.productionServerPath || `${basePath}/apps/${project.id}`;
    if (server.role === 'build') return `${basePath}/workspaces/${project.id}`;
    return `${basePath}/repos/${project.id}`;
  }

  isLocal(server: TargetServer) {
    return server.id === this.config.serverId;
  }

  private run(server: TargetServer, script: string, timeoutMs: number) {
    const args = sshArgsForServer(server, this.config.gitSshKeyPath);
    return new Promise<CommandResult>((resolvePromise) => {
      const child = spawn('ssh', [...args, 'bash', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stderr += `\nRemote command timed out after ${timeoutMs}ms.`;
        child.kill('SIGTERM');
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => { stderr += `\n${error.message}`; });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ stdout, stderr, code });
      });
      child.stdin.end(script);
    });
  }
}

function sshArgsForServer(server: TargetServer, gitSshKeyPath?: string) {
  if (server.sshAuthType === 'system_default' && server.sshTarget) return splitShellWords(server.sshTarget.replace(/^ssh\s+/, ''));
  const platformForwarded = isLoopbackHost(server.sshHost) && server.host && !isLoopbackHost(server.host);
  const host = platformForwarded ? server.host : server.sshHost || server.host;
  const user = server.sshUser;
  if (!host || !user) throw new Error(`Server ${server.name} is missing sshHost/host or sshUser`);
  const args = ['-p', String(platformForwarded ? 22 : server.sshPort ?? 22), '-o', 'StrictHostKeyChecking=accept-new'];
  if (gitSshKeyPath) args.push('-i', gitSshKeyPath, '-o', 'IdentitiesOnly=yes');
  args.push(`${user}@${host}`);
  return args;
}

function repoSyncScript(repositoryUrl: string, gitRef: string, targetPath: string, gitSshKeyPath?: string) {
  return [
    'set -euo pipefail',
    `target=${shellQuote(targetPath)}`,
    `repo=${shellQuote(repositoryUrl)}`,
    `ref=${shellQuote(gitRef)}`,
    'current_user="$(id -un)"',
    'current_group="$(id -gn)"',
    'SUDO=""',
    'if [ "$(id -u)" != "0" ]; then',
    '  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; fi',
    'fi',
    'parent="$(dirname "$target")"',
    'if ! mkdir -p "$parent" 2>/dev/null; then',
    '  if [ -z "$SUDO" ]; then echo "Cannot create $parent and passwordless sudo is unavailable." >&2; exit 73; fi',
    '  $SUDO mkdir -p "$parent"',
    '  $SUDO chown "$current_user:$current_group" "$parent"',
    'fi',
    'if [ -e "$target" ] && [ ! -w "$target" ]; then',
    '  if [ -z "$SUDO" ]; then echo "Cannot write $target and passwordless sudo is unavailable." >&2; exit 74; fi',
    '  $SUDO chown -R "$current_user:$current_group" "$target"',
    'fi',
    remoteGitAuthScript(gitSshKeyPath),
    'if [ ! -d "$target/.git" ]; then git clone "$repo" "$target"; fi',
    'cd "$target"',
    'git remote set-url origin "$repo" || true',
    'git fetch --all --tags --prune',
    'git checkout "$ref"',
    'git reset --hard "$ref"',
    'git clean -fd',
    'printf "synced:%s:%s\\n" "$target" "$ref"',
  ].join('\n');
}

function remoteGitAuthScript(keyPath?: string) {
  if (!keyPath || !existsSync(keyPath)) return 'export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30"';
  const encodedKey = Buffer.from(readFileSync(keyPath, 'utf8')).toString('base64');
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
