import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1 as const;

export const AgentCapabilityValues = [
  'repo.inspect',
  'repo.sync',
  'jenkins.run',
  'codex.exec',
  'codex.fix',
  'repo.write',
  'incident.analyze',
  'observability.preflight',
] as const;

export const AgentCapabilitySchema = z.enum(AgentCapabilityValues);
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const AgentStatusSchema = z.enum(['online', 'offline', 'degraded', 'disabled']);
export const ReadinessCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string().optional(),
});
export const AgentReadinessSchema = z.object({
  ready: z.boolean(),
  status: z.enum(['ready', 'degraded', 'blocked']),
  checks: z.array(ReadinessCheckSchema),
});

const VersionIdentitySchema = z.object({
  agentVersion: z.string().min(1),
  buildRevision: z.string().min(7),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  supportedProtocolVersions: z.array(z.number().int().positive()).min(1),
});

export const AgentRegistrationRequestSchema = VersionIdentitySchema.extend({
  id: z.string().min(1),
  name: z.string().min(1),
  status: AgentStatusSchema,
  serverId: z.string().min(1).optional(),
  poolId: z.string().min(1).optional(),
  endpoint: z.string().min(1).optional(),
  capabilities: z.array(AgentCapabilitySchema),
  labels: z.record(z.string(), z.string()).optional(),
  readiness: AgentReadinessSchema,
  runtimeStatus: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AgentRegistrationRequest = z.infer<typeof AgentRegistrationRequestSchema>;

export const AgentHeartbeatRequestSchema = VersionIdentitySchema.extend({
  status: AgentStatusSchema,
  serverId: z.string().min(1).optional(),
  capabilities: z.array(AgentCapabilitySchema),
  readiness: AgentReadinessSchema,
  runtimeStatus: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AgentHeartbeatRequest = z.infer<typeof AgentHeartbeatRequestSchema>;

export const ProtocolNegotiationSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  minimumSupportedProtocolVersion: z.literal(MIN_SUPPORTED_PROTOCOL_VERSION),
  compatible: z.boolean(),
  capabilities: z.array(AgentCapabilitySchema),
});
export type ProtocolNegotiation = z.infer<typeof ProtocolNegotiationSchema>;

export const AgentClaimRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  leaseSeconds: z.number().int().min(30).max(3600).optional(),
  capabilities: z.array(AgentCapabilitySchema).optional(),
});
export type AgentClaimRequest = z.infer<typeof AgentClaimRequestSchema>;

export const JobTypeSchema = z.enum([
  'repo.inspect',
  'repo.sync',
  'repo.install',
  'jenkins.pipeline.run',
  'codex.incident.analyze',
  'codex.fix.create_patch',
  'codex.fix.merge_to_production',
  'observability.preflight',
]);

const ProjectJobParamsSchema = z.object({
  project: z.object({ id: z.string().min(1), repositoryUrl: z.string().min(1) }).passthrough(),
  gitRef: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).passthrough();

export const JobParamsEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('repo.inspect'), params: ProjectJobParamsSchema.extend({ generateRuntimeContract: z.boolean().optional() }) }),
  z.object({ type: z.literal('repo.sync'), params: ProjectJobParamsSchema.extend({ targetServer: z.record(z.string(), z.unknown()) }) }),
  z.object({ type: z.literal('repo.install'), params: ProjectJobParamsSchema.extend({ targetServer: z.record(z.string(), z.unknown()) }) }),
  z.object({ type: z.literal('jenkins.pipeline.run'), params: ProjectJobParamsSchema }),
  z.object({ type: z.literal('codex.incident.analyze'), params: z.object({ incident: z.record(z.string(), z.unknown()) }).passthrough() }),
  z.object({ type: z.literal('codex.fix.create_patch'), params: z.object({ incident: z.record(z.string(), z.unknown()) }).passthrough() }),
  z.object({ type: z.literal('codex.fix.merge_to_production'), params: z.object({ fix: z.record(z.string(), z.unknown()) }).passthrough() }),
  z.object({ type: z.literal('observability.preflight'), params: z.record(z.string(), z.unknown()) }),
]);
export type JobParamsEnvelope = z.infer<typeof JobParamsEnvelopeSchema>;

export const JobResultSchema = z.record(z.string(), z.unknown());
export type JobResult = z.infer<typeof JobResultSchema>;

export const JobEventRequestSchema = z.object({
  attemptId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  type: z.string().min(1),
  status: z.string().optional(),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type JobEventRequest = z.infer<typeof JobEventRequestSchema>;

export const JobCompleteRequestSchema = z.object({
  agentId: z.string().min(1),
  attemptId: z.string().min(1),
  resultSummary: JobResultSchema,
  agentWorkspacePath: z.string().optional(),
});
export type JobCompleteRequest = z.infer<typeof JobCompleteRequestSchema>;

export const JobFailRequestSchema = z.object({
  agentId: z.string().min(1),
  attemptId: z.string().min(1),
  errorSummary: z.string().min(1),
  resultSummary: JobResultSchema.optional(),
});
export type JobFailRequest = z.infer<typeof JobFailRequestSchema>;

export const AgentApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type AgentApiError = z.infer<typeof AgentApiErrorSchema>;

export function negotiateProtocol(input: { protocolVersion: number; supportedProtocolVersions: number[]; capabilities: readonly string[] }): ProtocolNegotiation {
  const compatible = input.protocolVersion === PROTOCOL_VERSION && input.supportedProtocolVersions.includes(PROTOCOL_VERSION);
  return ProtocolNegotiationSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    minimumSupportedProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
    compatible,
    capabilities: input.capabilities.filter((capability): capability is AgentCapability => AgentCapabilitySchema.safeParse(capability).success),
  });
}
