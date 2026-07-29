import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { ManagedRuntimeConfigKind, Project } from '@zhenfengxx/contracts';
import { isLoopbackHost, shellQuote, splitShellWords, type CommandResult, type TargetServer } from '../common.js';
import type { AgentConfig } from '../config.js';

export interface RemoteAdapter {
  syncProject(project: Project, server: TargetServer, gitRef: string, install: boolean, timeoutMs: number): Promise<CommandResult & { targetPath: string; commitSha?: string }>;
  cleanupRuntime(project: Project, server: TargetServer, cleanup: RuntimeCleanupSpec, timeoutMs: number): Promise<CommandResult>;
  testConnection(server: TargetServer, timeoutMs: number): Promise<CommandResult>;
  probeRuntimeConfig(server: TargetServer, targetPath: string, kind: ManagedRuntimeConfigKind, config: Record<string, unknown>, timeoutMs: number): Promise<CommandResult>;
  targetPath(project: Project, server: TargetServer): string;
  isLocal(server: TargetServer): boolean;
}

export type RuntimeCleanupSpec = {
  paths?: string[];
  aliasPaths?: RuntimeCleanupAlias[];
  allowedPrefixes?: string[];
  stopRuntime?: boolean;
  pm2AppName?: string;
  dockerContainerName?: string;
};

export type RuntimeCleanupAlias = {
  path: string;
  target: string;
};

const REMOTE_TIMEOUT_KILL_AFTER_SECONDS = 15;
const TRANSPORT_TIMEOUT_GRACE_MS = 20_000;
const TRANSPORT_FORCE_KILL_MS = 5_000;

export class SshRemoteAdapter implements RemoteAdapter {
  constructor(private readonly config: AgentConfig) {}

  async syncProject(project: Project, server: TargetServer, gitRef: string, install: boolean, timeoutMs: number) {
    const targetPath = this.targetPath(project, server);
    const script = `${repoSyncScript(project.repositoryUrl, gitRef, targetPath, this.config.gitSshKeyPath)}${install ? `\n${repoInstallScript(targetPath)}` : ''}`;
    const result = await this.run(server, script, timeoutMs);
    const commitSha = result.stdout.match(/^synced_commit:([0-9a-f]{40,64})$/im)?.[1]?.toLowerCase();
    return { ...result, targetPath, ...(commitSha ? { commitSha } : {}) };
  }

  async cleanupRuntime(project: Project, server: TargetServer, cleanup: RuntimeCleanupSpec, timeoutMs: number) {
    return this.run(server, runtimeCleanupScript(project.id, cleanup), timeoutMs);
  }

  async testConnection(server: TargetServer, timeoutMs: number) {
    return this.run(server, 'set -euo pipefail\nprintf "connected:%s:%s\\n" "$(hostname)" "$(id -un)"', timeoutMs);
  }

  async probeRuntimeConfig(server: TargetServer, targetPath: string, kind: ManagedRuntimeConfigKind, config: Record<string, unknown>, timeoutMs: number) {
    return this.run(server, runtimeConfigProbeScript(targetPath, kind, config), timeoutMs);
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
    const args = sshArgsForServer(server, this.config.targetSshKeyPath ?? this.config.gitSshKeyPath);
    return new Promise<CommandResult>((resolvePromise) => {
      const child = spawn('ssh', [...args, ...remoteCommandArgs(timeoutMs)], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        stderr += `\nRemote command transport did not exit after ${timeoutMs}ms plus ${TRANSPORT_TIMEOUT_GRACE_MS}ms grace.`;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), TRANSPORT_FORCE_KILL_MS);
      }, timeoutMs + TRANSPORT_TIMEOUT_GRACE_MS);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => { stderr += `\n${error.message}`; });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (code === 124) stderr += `\nRemote command timed out after ${timeoutMs}ms.`;
        resolvePromise({ stdout, stderr, code });
      });
      child.stdin.end(script);
    });
  }
}

export function runtimeConfigProbeScript(targetPath: string, kind: ManagedRuntimeConfigKind, config: Record<string, unknown>) {
  const encodedConfig = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  return [
    'set -euo pipefail',
    'umask 077',
    `target=${shellQuote(targetPath)}`,
    `config_kind=${shellQuote(kind)}`,
    'case "$target" in /*) ;; *) echo "Runtime config probe target must be absolute." >&2; exit 72 ;; esac',
    'if [ ! -d "$target" ] || [ ! -f "$target/package.json" ]; then echo "Runtime config probe target is not a Node.js project." >&2; exit 72; fi',
    'probe_dir="$(mktemp -d)"',
    'trap \'rm -rf "$probe_dir"\' EXIT HUP INT TERM',
    `printf %s ${shellQuote(encodedConfig)} | base64 -d > "$probe_dir/config.json"`,
    'chmod 600 "$probe_dir/config.json"',
    'cd "$target"',
    'RUNTIME_CONFIG_KIND="$config_kind" RUNTIME_CONFIG_PATH="$probe_dir/config.json" node <<\'NODE\'',
    runtimeConfigProbeNodeProgram(),
    'NODE',
  ].join('\n');
}

function runtimeConfigProbeNodeProgram() {
  return String.raw`const fs = require('node:fs');
const net = require('node:net');
const kind = process.env.RUNTIME_CONFIG_KIND;
const config = JSON.parse(fs.readFileSync(process.env.RUNTIME_CONFIG_PATH, 'utf8'));

async function probePostgres() {
  const { Client } = require('pg');
  const client = new Client({ ...config, connectionTimeoutMillis: Number(config.connectionTimeoutMillis || 10000) });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function probeMysql() {
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({ ...config, connectTimeout: Number(config.connectTimeout || 10000) });
  try {
    await connection.query('SELECT 1');
  } finally {
    await connection.end();
  }
}

function redisCommand(socket, args) {
  const payload = '*' + args.length + '\r\n' + args.map((value) => {
    const text = String(value);
    return '$' + Buffer.byteLength(text) + '\r\n' + text + '\r\n';
  }).join('');
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = buffer.subarray(0, end).toString('utf8');
      if (!line) return;
      cleanup();
      if (line[0] === '-') reject(new Error('Redis rejected the probe: ' + line.slice(1)));
      else resolve(line);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(payload);
  });
}

async function probeRedis() {
  const socket = net.createConnection({ host: config.host, port: Number(config.port || 6379) });
  socket.setTimeout(Number(config.connectTimeout || 10000), () => socket.destroy(new Error('Redis connection timed out')));
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    if (config.password) await redisCommand(socket, config.username ? ['AUTH', config.username, config.password] : ['AUTH', config.password]);
    if (config.db !== undefined && config.db !== null) await redisCommand(socket, ['SELECT', config.db]);
    await redisCommand(socket, ['PING']);
  } finally {
    socket.destroy();
  }
}

(async () => {
  if (kind === 'oak_postgres') await probePostgres();
  else if (kind === 'oak_mysql') await probeMysql();
  else if (kind === 'oak_redis') await probeRedis();
  else throw new Error('Unsupported runtime config kind');
  process.stdout.write('runtime_config_probe:success:' + kind + '\n');
})().catch((error) => {
  process.stderr.write('runtime_config_probe:failed:' + (error && error.message ? error.message : 'unknown error') + '\n');
  process.exitCode = 1;
});`;
}

export function remoteCommandArgs(timeoutMs: number) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  return [
    'timeout',
    '--signal=TERM',
    `--kill-after=${REMOTE_TIMEOUT_KILL_AFTER_SECONDS}s`,
    `${timeoutSeconds}s`,
    'bash',
    '-s',
  ];
}

export function sshArgsForServer(server: TargetServer, targetSshKeyPath?: string) {
  const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'];
  if (targetSshKeyPath) options.push('-i', targetSshKeyPath, '-o', 'IdentitiesOnly=yes');
  if (server.sshAuthType === 'system_default' && server.sshTarget) {
    return [...options, ...splitShellWords(server.sshTarget.replace(/^ssh\s+/, ''))];
  }
  const platformForwarded = isLoopbackHost(server.sshHost) && server.host && !isLoopbackHost(server.host);
  const host = platformForwarded ? server.host : server.sshHost || server.host;
  const user = server.sshUser;
  if (!host || !user) throw new Error(`Server ${server.name} is missing sshHost/host or sshUser`);
  const args = [...options, '-p', String(platformForwarded ? 22 : server.sshPort ?? 22)];
  args.push(`${user}@${host}`);
  return args;
}

export function repoSyncScript(repositoryUrl: string, gitRef: string, targetPath: string, gitSshKeyPath?: string) {
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
    transientGitRetryScript(),
    remoteGitAuthScript(gitSshKeyPath),
    'if [ ! -d "$target/.git" ]; then run_with_git_retry git clone --no-checkout "$repo" "$target"; fi',
    'cd "$target"',
    'git remote set-url origin "$repo"',
    'run_with_git_retry git fetch origin --tags --prune',
    'branch="${ref#refs/remotes/origin/}"',
    'branch="${branch#refs/heads/}"',
    'branch="${branch#origin/}"',
    'tag="${ref#refs/tags/}"',
    'if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then',
    '  commit="$(git rev-parse --verify "refs/remotes/origin/$branch^{commit}")"',
    'elif git show-ref --verify --quiet "refs/tags/$tag"; then',
    '  commit="$(git rev-parse --verify "refs/tags/$tag^{commit}")"',
    'elif git cat-file -e "$ref^{commit}" 2>/dev/null; then',
    '  commit="$(git rev-parse --verify "$ref^{commit}")"',
    'else',
    '  echo "Git ref was not found after fetching origin: $ref" >&2',
    '  exit 75',
    'fi',
    'case "$commit" in (*[!0-9a-fA-F]*|\'\') echo "Resolved Git commit is invalid: $commit" >&2; exit 75;; esac',
    'git checkout --detach "$commit"',
    'git reset --hard "$commit"',
    'git clean -fd',
    'printf "synced:%s:%s:%s\\n" "$target" "$ref" "$commit"',
    'printf "synced_commit:%s\\n" "$commit"',
  ].join('\n');
}

function transientGitRetryScript() {
  return [
    'is_transient_git_failure() {',
    '  local log="$1"',
    '  if grep -Eiq "permission denied|authentication failed|repository not found|repository .* does not exist|host key verification failed" "$log"; then return 1; fi',
    '  grep -Eiq "connection (closed|reset|timed out)|connection reset by peer|remote host closed the connection|kex_exchange_identification|ssh_exchange_identification|temporary failure in name resolution|could not resolve host(name)?|connection refused|fetch-pack: unexpected disconnect|remote end hung up unexpectedly|early eof|rpc failed;.*curl (18|28|56)" "$log"',
    '}',
    'run_with_git_retry() {',
    '  local attempt=1 max_attempts=3 delay=2 log code',
    '  while true; do',
    '    log="$(mktemp)"',
    '    if "$@" 2>"$log"; then cat "$log" >&2; rm -f "$log"; return 0; else code=$?; fi',
    '    cat "$log" >&2',
    '    if [ "$attempt" -ge "$max_attempts" ] || ! is_transient_git_failure "$log"; then rm -f "$log"; return "$code"; fi',
    '    echo "Transient Git/SSH failure; retrying attempt $((attempt + 1))/$max_attempts after ${delay}s: $*" >&2',
    '    rm -f "$log"',
    '    sleep "$delay"',
    '    attempt=$((attempt + 1))',
    '    delay=$((delay + 3))',
    '  done',
    '}',
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

export function repoInstallScript(targetPath: string) {
  return [
    `cd ${shellQuote(targetPath)}`,
    'export NODE_ENV=development npm_config_omit=',
    'is_oak_git_cli_project() {',
    "  node -e 'const p=require(\"./package.json\"); const oak=p.oak && typeof p.oak===\"object\"; const cli=p.devDependencies?.[\"@xuchangzju/oak-cli\"]; process.exit(oak && typeof cli===\"string\" && /^(git\\+ssh|git\\+https|ssh:|git@)/i.test(cli) ? 0 : 1)'",
    '}',
    'npm_oak_isolated_install() {',
    '  echo "Oak Git dependency layout detected; isolating dependency lifecycle scripts."',
    '  run_with_git_retry "$@" --legacy-peer-deps --ignore-scripts',
    '  npm run postinstall --if-present',
    '}',
    'npm_with_peer_fallback() {',
    '  local npm_log npm_code',
    '  npm_log="$(mktemp)"',
    '  if run_with_git_retry "$@" 2>"$npm_log"; then cat "$npm_log" >&2; rm -f "$npm_log"; return 0; else npm_code=$?; fi',
    '  cat "$npm_log" >&2',
    '  if grep -q "ERESOLVE" "$npm_log"; then',
    '    echo "Strict npm dependency resolution failed with ERESOLVE; retrying with --legacy-peer-deps."',
    '    rm -f "$npm_log"',
    '    run_with_git_retry "$@" --legacy-peer-deps',
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
    'if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then run_with_git_retry pnpm install --frozen-lockfile --prod=false;',
    'elif [ -f package-lock.json ] && git ls-files --error-unmatch -- package-lock.json >/dev/null 2>&1; then if is_oak_git_cli_project; then npm_oak_isolated_install npm ci --include=dev; else npm_with_peer_fallback npm ci --include=dev; fi;',
    'elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then run_with_git_retry yarn install --frozen-lockfile --production=false;',
    'elif [ -f package.json ]; then rm -f package-lock.json; if is_oak_git_cli_project; then npm_oak_isolated_install npm install --include=dev --package-lock=false; else npm_with_peer_fallback npm install --include=dev --package-lock=false; fi;',
    'else echo "No package.json found; dependency install skipped."; fi',
  ].join('\n');
}

function runtimeCleanupScript(projectId: string, cleanup: RuntimeCleanupSpec) {
  const paths = Array.from(new Set((cleanup.paths ?? []).map((item) => String(item ?? '').trim()).filter(Boolean)));
  const quotedPaths = paths.map((path) => shellQuote(path)).join(' ');
  const configuredPrefixes = Array.from(new Set((cleanup.allowedPrefixes?.length ? cleanup.allowedPrefixes : ['/opt/autodevops/apps/', '/opt/autodevops/workspaces/', '/opt/autodevops/repos/']).map((item) => String(item ?? '').trim()).filter((item) => item.startsWith('/') && item.endsWith('/'))));
  const allowedPrefixes = configuredPrefixes.length ? configuredPrefixes : ['/opt/autodevops/apps/', '/opt/autodevops/workspaces/', '/opt/autodevops/repos/'];
  const quotedPrefixes = allowedPrefixes.map((prefix) => shellQuote(prefix)).join(' ');
  const aliases = Array.from(new Map((cleanup.aliasPaths ?? [])
    .map((alias) => ({ path: String(alias.path ?? '').trim(), target: String(alias.target ?? '').trim() }))
    .filter((alias) => alias.path && alias.target)
    .map((alias) => [`${alias.path}\n${alias.target}`, alias] as const)).values());
  const pm2AppName = cleanup.stopRuntime ? String(cleanup.pm2AppName ?? '').trim() : '';
  const dockerContainerName = cleanup.stopRuntime ? String(cleanup.dockerContainerName ?? '').trim() : '';
  const pathLoop = paths.length
    ? [
        `for target in ${quotedPaths}; do`,
        '  if ! is_safe_path "$target"; then echo "refusing_unsafe_path:$target" >&2; exit 72; fi',
        '  if [ -e "$target" ]; then',
        '    if rm -rf "$target" 2>/dev/null; then echo "removed:$target";',
        '    else',
        '      if [ -z "$SUDO" ]; then echo "Cannot remove $target and passwordless sudo is unavailable." >&2; exit 73; fi',
        '      $SUDO rm -rf "$target"',
        '      echo "removed_with_sudo:$target"',
        '    fi',
        '  else echo "missing:$target"; fi',
        'done',
      ]
    : ['echo "no_cleanup_paths"'];
  const aliasLoop = aliases.length
    ? aliases.flatMap((alias) => [
        `alias_path=${shellQuote(alias.path)}`,
        `alias_target=${shellQuote(alias.target)}`,
        'if ! is_safe_path "$alias_path" || ! is_safe_path "$alias_target"; then echo "refusing_unsafe_alias:$alias_path" >&2; exit 72; fi',
        'if [ -L "$alias_path" ]; then',
        '  link_target="$(readlink "$alias_path" 2>/dev/null || true)"',
        '  target_match=false',
        '  if [ "$link_target" = "$alias_target" ]; then target_match=true; fi',
        '  if [ "$target_match" = false ] && [ -e "$alias_target" ]; then',
        '    alias_real="$(readlink -f -- "$alias_path" 2>/dev/null || true)"',
        '    target_real="$(readlink -f -- "$alias_target" 2>/dev/null || true)"',
        '    if [ -n "$alias_real" ] && [ "$alias_real" = "$target_real" ]; then target_match=true; fi',
        '  fi',
        '  if [ "$target_match" = true ]; then',
        '    if rm -f -- "$alias_path"; then echo "removed_alias:$alias_path";',
        '    elif [ -n "$SUDO" ]; then $SUDO rm -f -- "$alias_path"; echo "removed_alias_with_sudo:$alias_path";',
        '    else echo "Cannot remove alias $alias_path and passwordless sudo is unavailable." >&2; exit 73; fi',
        '  else echo "alias_mismatch:$alias_path"; fi',
        'else echo "alias_missing:$alias_path"; fi',
      ])
    : ['echo "no_cleanup_aliases"'];
  return [
    'set -euo pipefail',
    `project_id=${shellQuote(projectId)}`,
    `pm2_name=${shellQuote(pm2AppName)}`,
    `docker_container=${shellQuote(dockerContainerName)}`,
    'current_user="$(id -un)"',
    'current_group="$(id -gn)"',
    'SUDO=""',
    'if [ "$(id -u)" != "0" ]; then',
    '  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; fi',
    'fi',
    'is_safe_path() {',
    `  for prefix in ${quotedPrefixes}; do`,
    '    case "$1" in "$prefix"*) return 0 ;; esac',
    '  done',
    '  return 1',
    '}',
    'if [ -n "$pm2_name" ] && command -v pm2 >/dev/null 2>&1; then',
    '  if pm2 describe "$pm2_name" >/dev/null 2>&1; then pm2 delete "$pm2_name"; echo "pm2_deleted:$pm2_name"; else echo "pm2_missing:$pm2_name"; fi',
    'fi',
    'if [ -n "$docker_container" ] && command -v docker >/dev/null 2>&1; then',
    '  if docker inspect "$docker_container" >/dev/null 2>&1; then $SUDO docker rm -f "$docker_container"; echo "docker_removed:$docker_container"; else echo "docker_missing:$docker_container"; fi',
    'fi',
    ...aliasLoop,
    ...pathLoop,
    'echo "cleanup_complete:$project_id"',
  ].join('\n');
}
