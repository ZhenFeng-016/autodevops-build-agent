import { spawn, type ChildProcess } from 'node:child_process';

export type ProcessExecutionOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
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
};

const FORCE_KILL_DELAY_MS = 5_000;

export function execFileWithProcessTree(command: string, args: string[], options: ProcessExecutionOptions = {}) {
  return new Promise<ProcessExecutionResult>((resolvePromise, rejectPromise) => {
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

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (!spawnError && !timedOut && code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const message = timedOut
        ? `Command timed out after ${options.timeout}ms: ${command} ${args.join(' ')}`
        : spawnError?.message ?? `Command failed with exit code ${code}: ${command} ${args.join(' ')}`;
      rejectPromise(Object.assign(new Error(message), {
        code,
        signal,
        stdout,
        stderr,
        timedOut,
      }) satisfies ProcessExecutionFailure);
    });
  });
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
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
