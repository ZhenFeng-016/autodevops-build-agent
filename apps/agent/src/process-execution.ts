import { spawn, type ChildProcess } from 'node:child_process';

export type ProcessExecutionOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  signal?: AbortSignal;
};

export type ProcessExecutionResult = {
  stdout: string;
  stderr: string;
};

type ProcessExecutionFailure = Error & {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

const FORCE_KILL_DELAY_MS = 5_000;

export function execFileWithProcessTree(command: string, args: string[], options: ProcessExecutionOptions = {}) {
  return new Promise<ProcessExecutionResult>((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted) {
      rejectPromise(processFailure(`Command cancelled before start: ${command} ${args.join(' ')}`, null, null, '', '', false, true));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let spawnError: Error | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child, 'SIGTERM');
          if (process.platform !== 'win32') {
            forceKillTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), FORCE_KILL_DELAY_MS);
          }
        }, options.timeout)
      : undefined;
    const onAbort = () => {
      aborted = true;
      terminateProcessTree(child, 'SIGTERM');
      if (process.platform !== 'win32') {
        forceKillTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), FORCE_KILL_DELAY_MS);
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (!spawnError && !timedOut && !aborted && code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const message = aborted
        ? `Command cancelled: ${command} ${args.join(' ')}`
        : timedOut
        ? `Command timed out after ${options.timeout}ms: ${command} ${args.join(' ')}`
        : spawnError?.message ?? `Command failed with exit code ${code}: ${command} ${args.join(' ')}`;
      rejectPromise(processFailure(message, code, signal, stdout, stderr, timedOut, aborted));
    });
  });
}

function processFailure(message: string, code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean) {
  return Object.assign(new Error(message), { code, signal, stdout, stderr, timedOut, aborted, cancelled: aborted }) satisfies ProcessExecutionFailure & { cancelled: boolean };
}

export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
