import type { AgentHeartbeatRequest, AgentRegistrationRequest, ClaimedJob, JobCompleteRequest, JobEventRequest, JobFailRequest, Project } from '@zhenfengxx/contracts';
import { PROTOCOL_VERSION } from '@zhenfengxx/contracts';
import { AgentClient } from '@zhenfengxx/agent-sdk';
import type { AgentConfig } from './config.js';

export class ControlPlaneClient {
  private readonly client: AgentClient;

  constructor(private readonly config: AgentConfig, fetchImpl: typeof fetch = fetch) {
    this.client = new AgentClient(config.apiBaseUrl, {
      agentId: config.agentId,
      secret: config.authSecret,
      token: config.authToken,
    }, fetchImpl);
  }

  register(body: AgentRegistrationRequest) {
    return this.client.register(body);
  }

  heartbeat(body: AgentHeartbeatRequest) {
    return this.client.heartbeat(body);
  }

  claimJob(leaseSeconds = 900) {
    return this.client.claimJob({ protocolVersion: PROTOCOL_VERSION, capabilities: [...AGENT_CAPABILITIES], leaseSeconds });
  }

  event(jobId: string, body: JobEventRequest) {
    return this.client.appendEvent(jobId, body);
  }

  complete(jobId: string, body: JobCompleteRequest) {
    return this.client.completeJob(jobId, body);
  }

  fail(jobId: string, body: JobFailRequest) {
    return this.client.failJob(jobId, body);
  }

  async project(projectId: string) {
    const response = await fetch(`${this.config.apiBaseUrl}/projects`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`API GET /projects failed: ${response.status} ${await response.text()}`);
    const projects = await response.json() as Project[];
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }
}

export const AGENT_CAPABILITIES = [
  'repo.inspect',
  'repo.sync',
  'jenkins.run',
  'codex.exec',
  'codex.fix',
  'repo.write',
  'incident.analyze',
  'observability.preflight',
] as const;

export type ClaimedAgentJob = ClaimedJob | { claimed: false };
