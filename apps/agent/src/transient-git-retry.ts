import { commandErrorOutput, sleep } from './common.js';

const TRANSIENT_GIT_FAILURE_PATTERNS = [
  /connection (?:closed|reset|timed out)/i,
  /connection reset by peer/i,
  /remote host closed the connection/i,
  /kex_exchange_identification/i,
  /ssh_exchange_identification/i,
  /temporary failure in name resolution/i,
  /could not resolve host(?:name)?/i,
  /connection refused/i,
  /fetch-pack: unexpected disconnect/i,
  /the remote end hung up unexpectedly/i,
  /early eof/i,
  /rpc failed;.*(?:curl 18|curl 28|curl 56)/i,
];

const PERMANENT_GIT_FAILURE_PATTERNS = [
  /permission denied/i,
  /authentication failed/i,
  /repository not found/i,
  /repository .* does not exist/i,
  /host key verification failed/i,
];

export type TransientGitRetryEvent = {
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  output: string;
};

export type TransientGitRetryOptions = {
  maxAttempts?: number;
  delaysMs?: number[];
  sleepFn?: (ms: number) => Promise<unknown>;
  onRetry?: (event: TransientGitRetryEvent) => void;
};

export function isTransientGitFailure(errorOrOutput: unknown) {
  const output = typeof errorOrOutput === 'string' ? errorOrOutput : commandErrorOutput(errorOrOutput);
  if (PERMANENT_GIT_FAILURE_PATTERNS.some((pattern) => pattern.test(output))) return false;
  return TRANSIENT_GIT_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

export async function withTransientGitRetry<T>(operation: (attempt: number) => Promise<T>, options: TransientGitRetryOptions = {}) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const delaysMs = options.delaysMs?.length ? options.delaysMs : [2_000, 5_000];
  const sleepFn = options.sleepFn ?? sleep;
  let attempt = 1;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (error && typeof error === 'object' && (error as { timedOut?: unknown }).timedOut === true) throw error;
      if (attempt >= maxAttempts || !isTransientGitFailure(error)) throw error;
      const delayMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0;
      options.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        output: commandErrorOutput(error),
      });
      if (delayMs > 0) await sleepFn(delayMs);
      attempt += 1;
    }
  }
}
