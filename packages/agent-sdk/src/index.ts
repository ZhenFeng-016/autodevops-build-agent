import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AgentClaimRequestSchema,
  AgentHeartbeatRequestSchema,
  AgentRegistrationRequestSchema,
  JobCompleteRequestSchema,
  JobEventRequestSchema,
  JobFailRequestSchema,
  type AgentClaimRequest,
  type AgentHeartbeatRequest,
  type AgentRegistrationRequest,
  type BuildAgent,
  type ClaimedJob,
  type JobCompleteRequest,
  type JobEvent,
  type JobEventRequest,
  type JobFailRequest,
} from '@zhenfengxx/contracts';

export type AgentCredentials = { agentId: string; secret?: string; token?: string };
export type WorkerSignatureInput = { method: string; path: string; timestamp: string; rawBody: string; secret: string };

export function createWorkerSignature(input: WorkerSignatureInput) {
  const payload = [input.method.toUpperCase(), input.path, input.timestamp, input.rawBody].join('\n');
  return createHmac('sha256', input.secret).update(payload).digest('hex');
}

export function isFreshWorkerTimestamp(timestamp: string, nowMs: number, maxSkewSeconds: number) {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const timestampMs = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  return Math.abs(nowMs - timestampMs) <= maxSkewSeconds * 1000;
}

export function verifyWorkerSignature(input: WorkerSignatureInput & { signature: string; nowMs?: number; maxSkewSeconds?: number }) {
  if (!isFreshWorkerTimestamp(input.timestamp, input.nowMs ?? Date.now(), input.maxSkewSeconds ?? 300)) return false;
  const expected = Buffer.from(createWorkerSignature(input), 'hex');
  const received = Buffer.from(input.signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function agentAuthHeaders(input: AgentCredentials & { method: string; path: string; body: unknown }) {
  const rawBody = JSON.stringify(input.body ?? {});
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Agent-Id': input.agentId };
  if (input.token) headers['X-Agent-Token'] = input.token;
  if (input.secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['X-Agent-Timestamp'] = timestamp;
    headers['X-Agent-Signature'] = createWorkerSignature({ method: input.method, path: input.path, timestamp, rawBody, secret: input.secret });
  }
  return headers;
}

export class AgentClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly credentials: AgentCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  register(agent: AgentRegistrationRequest) {
    return this.request<BuildAgent>('/build-agents/register', 'POST', AgentRegistrationRequestSchema.parse(agent));
  }

  heartbeat(agent: AgentHeartbeatRequest) {
    return this.request<BuildAgent>(`/build-agents/${encodeURIComponent(this.credentials.agentId)}/heartbeat`, 'POST', AgentHeartbeatRequestSchema.parse(agent));
  }

  claimJob(input: AgentClaimRequest) {
    return this.request<ClaimedJob | { claimed: false }>(`/build-agents/${encodeURIComponent(this.credentials.agentId)}/claim-job`, 'POST', AgentClaimRequestSchema.parse(input));
  }

  appendEvent(jobId: string, event: JobEventRequest) {
    return this.request<JobEvent>(`/jobs/${encodeURIComponent(jobId)}/events`, 'POST', JobEventRequestSchema.parse(event));
  }

  completeJob(jobId: string, result: JobCompleteRequest) {
    return this.request(`/jobs/${encodeURIComponent(jobId)}/complete`, 'POST', JobCompleteRequestSchema.parse(result));
  }

  failJob(jobId: string, result: JobFailRequest) {
    return this.request(`/jobs/${encodeURIComponent(jobId)}/fail`, 'POST', JobFailRequestSchema.parse(result));
  }

  async request<T = Record<string, unknown>>(path: string, method: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: agentAuthHeaders({ ...this.credentials, method, path, body }),
      body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`AutoDevOps API ${method} ${path} failed (${response.status}): ${text.slice(0, 1000)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}
