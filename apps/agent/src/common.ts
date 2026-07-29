import type { Project } from '@zhenfengxx/contracts';

export type TargetServer = {
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

export type CommandResult = { stdout: string; stderr: string; code: number | null };

export class JobExecutionCancelledError extends Error {
  readonly cancelled = true;

  constructor(message = 'Job execution was cancelled') {
    super(message);
    this.name = 'JobExecutionCancelledError';
  }
}

export function isJobExecutionCancelled(error: unknown) {
  return error instanceof JobExecutionCancelledError
    || Boolean(error && typeof error === 'object' && (error as { cancelled?: unknown; aborted?: unknown }).cancelled === true)
    || Boolean(error && typeof error === 'object' && (error as { aborted?: unknown }).aborted === true);
}

export function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new JobExecutionCancelledError(typeof signal.reason === 'string' ? signal.reason : undefined);
}

export function requireProject(value: unknown): Project {
  if (!value || typeof value !== 'object') throw new Error('project is required in job params');
  const candidate = value as Project;
  if (!candidate.id || !candidate.repositoryUrl) throw new Error('project id and repositoryUrl are required in job params');
  return candidate;
}

export function requireTargetServer(value: unknown): TargetServer {
  if (!value || typeof value !== 'object') throw new Error('targetServer is required');
  const server = value as TargetServer;
  if (!server.id) throw new Error('targetServer.id is required');
  if (!server.name) throw new Error('targetServer.name is required');
  return server;
}

export function required(value: unknown, name: string): string {
  const text = stringValue(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

export function stringValue(value: unknown) {
  return String(value ?? '').trim();
}

export function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

export function looksSecret(key: string) {
  return /(SECRET|TOKEN|PASSWORD|PASS|KEY|DATABASE_URL|DSN|CREDENTIAL)/i.test(key);
}

export function truthy(value: unknown) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

export function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function splitShellWords(value: string) {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')) ?? [];
}

export function isLoopbackHost(value?: string) {
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

export function errorMessage(error: unknown) {
  const output = commandErrorOutput(error);
  if (output.length <= 8_000) return output;
  const base = basicErrorMessage(error);
  const remaining = Math.max(0, 8_000 - base.length - 32);
  return `${base}\n...[command output truncated]...\n${output.slice(-remaining)}`;
}

export function commandErrorOutput(error: unknown) {
  if (!error || typeof error !== 'object') return basicErrorMessage(error);
  const candidate = error as { message?: string; stdout?: string; stderr?: string };
  return [candidate.message ?? basicErrorMessage(error), candidate.stdout, candidate.stderr].filter(Boolean).join('\n');
}

function basicErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JobExecutionCancelledError(typeof signal?.reason === 'string' ? signal.reason : undefined));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
