import { v7 as uuidv7 } from 'uuid';
import type { Incident, JenkinsBuildWebhook } from '@zhenfengxx/contracts';

const newEntityId = () => uuidv7();
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface JenkinsClientOptions {
  baseUrl: string;
  username?: string;
  apiToken?: string;
  password?: string;
  signal?: AbortSignal;
}

export type JenkinsParameterDefinition = {
  name: string;
  type: 'string' | 'password' | 'boolean';
  description?: string;
};

export class JenkinsClient {
  constructor(private readonly options: JenkinsClientOptions) {}

  async generateApiToken(tokenName: string): Promise<{ tokenName: string; tokenUuid?: string; tokenValue: string }> {
    if (!this.options.username || !this.options.password) {
      throw new Error('Jenkins username and password are required to generate an API token');
    }
    const headers = await this.requestHeaders('password');
    const search = new URLSearchParams({ newTokenName: tokenName });
    const response = await fetch(`${this.options.baseUrl}/user/${encodeURIComponent(this.options.username)}/descriptorByName/jenkins.security.ApiTokenProperty/generateNewToken?${search}`, {
      method: 'POST',
      headers,
      signal: this.options.signal,
    });
    if (!response.ok) {
      throw new Error(`Jenkins token generation failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const data = body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {};
    const tokenValue = stringValue(data.tokenValue);
    if (!tokenValue) throw new Error('Jenkins token generation response did not include tokenValue');
    return {
      tokenName: stringValue(data.tokenName) || tokenName,
      tokenUuid: optionalString(data.tokenUuid),
      tokenValue,
    };
  }

  async triggerBuild(jobName: string, params: Record<string, string | number | boolean>): Promise<{ queueUrl: string }> {
    const body = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    const response = await fetch(`${this.options.baseUrl}/job/${encodeURIComponent(jobName)}/buildWithParameters`, {
      method: 'POST',
      headers: { ...(await this.requestHeaders('token')), 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: this.options.signal,
    });
    if (!response.ok) {
      throw new Error(`Jenkins trigger failed: ${response.status} ${await response.text()}`);
    }
    return { queueUrl: response.headers.get('location') ?? '' };
  }

  async upsertPipelineJob(jobName: string, jenkinsfile: string, parameterDefinitions: JenkinsParameterDefinition[]): Promise<void> {
    const definitions = validateParameterDefinitions(parameterDefinitions);
    const configXml = pipelineJobConfig(jenkinsfile, definitions);
    const configUrl = `${this.options.baseUrl}/job/${encodeURIComponent(jobName)}/config.xml`;
    const headers = { ...(await this.requestHeaders('token')), 'Content-Type': 'application/xml' };
    const currentResponse = await fetch(configUrl, { headers, signal: this.options.signal });

    if (currentResponse.status === 404) {
      await currentResponse.text();
      const createResponse = await fetch(`${this.options.baseUrl}/createItem?name=${encodeURIComponent(jobName)}`, {
        method: 'POST',
        headers,
        body: configXml,
        signal: this.options.signal,
      });
      const createBody = await createResponse.text();
      if (!createResponse.ok && createResponse.status !== 400 && createResponse.status !== 409) {
        throw new Error(`Jenkins job create failed: ${createResponse.status} ${createBody}`);
      }
      if (!createResponse.ok) await this.updatePipelineJob(configUrl, configXml, headers);
    } else if (currentResponse.ok) {
      await currentResponse.text();
      await this.updatePipelineJob(configUrl, configXml, headers);
    } else {
      throw new Error(`Jenkins job inspection failed: ${currentResponse.status} ${await currentResponse.text()}`);
    }

    await this.verifyPipelineJob(configUrl, definitions, headers);
  }

  private async updatePipelineJob(configUrl: string, configXml: string, headers: Record<string, string>) {
    const response = await fetch(configUrl, {
      method: 'POST',
      headers,
      body: configXml,
      signal: this.options.signal,
    });
    if (!response.ok) throw new Error(`Jenkins job update failed: ${response.status} ${await response.text()}`);
  }

  private async verifyPipelineJob(configUrl: string, expected: JenkinsParameterDefinition[], headers: Record<string, string>) {
    const response = await fetch(configUrl, { headers, signal: this.options.signal });
    if (!response.ok) throw new Error(`Jenkins job verification failed: ${response.status} ${await response.text()}`);
    const configXml = await response.text();
    const actual = configuredParameterDefinitions(configXml);
    const missing = expected.map((item) => item.name).filter((name) => !actual.has(name));
    if (missing.length) throw new Error(`Jenkins job parameter verification failed; missing: ${missing.join(', ')}`);
    const mismatched = expected.filter((item) => actual.get(item.name) !== item.type);
    if (mismatched.length) {
      throw new Error(`Jenkins job parameter type verification failed: ${mismatched.map((item) => `${item.name} expected ${item.type}, got ${actual.get(item.name)}`).join('; ')}`);
    }
  }

  private authHeaders(mode: 'token' | 'password'): Record<string, string> {
    const secret = mode === 'password' ? this.options.password : this.options.apiToken;
    if (!this.options.username || !secret) return {};
    return {
      Authorization: `Basic ${Buffer.from(`${this.options.username}:${secret}`).toString('base64')}`,
    };
  }

  private async requestHeaders(mode: 'token' | 'password'): Promise<Record<string, string>> {
    const headers = this.authHeaders(mode);
    const crumb = await this.fetchCrumb(headers);
    return crumb ? { ...headers, [crumb.field]: crumb.value, ...(crumb.cookie ? { Cookie: crumb.cookie } : {}) } : headers;
  }

  private async fetchCrumb(headers: Record<string, string>): Promise<{ field: string; value: string; cookie?: string } | null> {
    try {
      const response = await fetch(`${this.options.baseUrl}/crumbIssuer/api/json`, { headers, signal: this.options.signal });
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, unknown>;
      const field = stringValue(body.crumbRequestField);
      const value = stringValue(body.crumb);
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
      return field && value ? { field, value, cookie } : null;
    } catch {
      return null;
    }
  }
}

export function normalizeJenkinsWebhook(body: Record<string, unknown>): JenkinsBuildWebhook {
  return {
    pipelineRunId: optionalString(body.pipelineRunId ?? body.pipeline_run_id ?? body.PIPELINE_RUN_ID),
    jobName: stringValue(body.jobName ?? body.job_name ?? body.name),
    buildNumber: numberValue(body.buildNumber ?? body.build_number ?? body.number),
    buildUrl: stringValue(body.buildUrl ?? body.build_url ?? body.url),
    status: normalizeBuildStatus(stringValue(body.status ?? body.result)),
    gitRef: optionalString(body.gitRef ?? body.git_ref),
    commitSha: optionalString(body.commitSha ?? body.commit_sha),
    stages: Array.isArray(body.stages)
      ? body.stages.map((item) => {
          const stage = item as Record<string, unknown>;
          return {
            name: stringValue(stage.name),
            status: normalizeStageStatus(stringValue(stage.status)),
            startedAt: optionalString(stage.startedAt ?? stage.started_at),
            finishedAt: optionalString(stage.finishedAt ?? stage.finished_at),
            logUrl: optionalString(stage.logUrl ?? stage.log_url),
            errorSummary: optionalString(stage.errorSummary ?? stage.error_summary),
          };
        })
      : [],
    release: body.release && typeof body.release === 'object' ? (body.release as JenkinsBuildWebhook['release']) : undefined,
  };
}

export function incidentFromAlertmanager(body: Record<string, unknown>): Incident[] {
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];
  return alerts.map((raw, index) => {
    const alert = raw as Record<string, unknown>;
    const labels = asStringRecord(alert.labels);
    const annotations = asStringRecord(alert.annotations);
    const projectId = labels.project || labels.project_id || labels.service || 'unknown-project';
    const environment = labels.environment || labels.env || 'prod';
    const startsAt = optionalString(alert.startsAt ?? alert.starts_at);
    return {
      id: newEntityId(),
      projectId,
      environment,
      status: 'open',
      severity: labels.severity === 'critical' ? 'critical' : 'warning',
      summary: annotations.summary || annotations.description || labels.alertname || 'Alertmanager incident',
      source: 'alertmanager',
      labels,
      evidence: {
        startsAt,
        endsAt: optionalString(alert.endsAt ?? alert.ends_at),
        lokiQuery: `{project="${projectId}",environment="${environment}"}`,
        prometheusQuery: annotations.prometheus_query || labels.alertname,
        excerpt: annotations.description,
      },
    };
  });
}

export class LokiClient {
  constructor(private readonly baseUrl: string) {}

  async queryRange(query: string, start?: string, end?: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ query });
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    const response = await fetch(`${this.baseUrl}/loki/api/v1/query_range?${params}`);
    if (!response.ok) throw new Error(`Loki query failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as Record<string, unknown>;
  }
}

export class PrometheusClient {
  constructor(private readonly baseUrl: string) {}

  async query(query: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ query });
    const response = await fetch(`${this.baseUrl}/api/v1/query?${params}`);
    if (!response.ok) throw new Error(`Prometheus query failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as Record<string, unknown>;
  }
}

export class CodexClient {
  async analyzeIncident(incident: Incident): Promise<{ diagnosis: string; fixType: 'config_fix' | 'code_fix' | 'pipeline_fix' | 'external_dependency' }> {
    const text = `${incident.summary} ${incident.evidence.excerpt ?? ''}`.toLowerCase();
    if (text.includes('jenkins') || text.includes('pipeline')) return { diagnosis: 'Pipeline failure requires Jenkinsfile or environment correction.', fixType: 'pipeline_fix' };
    if (text.includes('timeout') || text.includes('network')) return { diagnosis: 'External dependency or network issue detected.', fixType: 'external_dependency' };
    if (text.includes('env') || text.includes('config')) return { diagnosis: 'Runtime configuration issue detected.', fixType: 'config_fix' };
    return { diagnosis: 'Application code defect is likely; prepare a reviewed code fix.', fixType: 'code_fix' };
  }
}

export type WorkerSignatureInput = {
  method: string;
  path: string;
  timestamp: string;
  rawBody: string;
  secret: string;
};

export function createWorkerSignature(input: WorkerSignatureInput) {
  const payload = [input.method.toUpperCase(), input.path, input.timestamp, input.rawBody].join('\n');
  return createHmac('sha256', input.secret).update(payload).digest('hex');
}

export function verifyWorkerSignature(input: WorkerSignatureInput & { signature: string; nowMs?: number; maxSkewSeconds?: number }) {
  if (!isFreshWorkerTimestamp(input.timestamp, input.nowMs ?? Date.now(), input.maxSkewSeconds ?? 300)) return false;
  const expected = createWorkerSignature(input);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(input.signature, 'hex');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function isFreshWorkerTimestamp(timestamp: string, nowMs: number, maxSkewSeconds: number) {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const timestampMs = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  return Math.abs(nowMs - timestampMs) <= maxSkewSeconds * 1000;
}

export function agentAuthHeaders(input: { method: string; path: string; body: unknown; agentId: string; secret?: string; token?: string }) {
  const rawBody = JSON.stringify(input.body ?? {});
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Agent-Id': input.agentId,
  };
  if (input.token) headers['X-Agent-Token'] = input.token;
  if (input.secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['X-Agent-Timestamp'] = timestamp;
    headers['X-Agent-Signature'] = createWorkerSignature({
      method: input.method,
      path: input.path,
      timestamp,
      rawBody,
      secret: input.secret,
    });
  }
  return headers;
}

export async function runCodexExec(input: {
  prompt: string;
  workspacePath: string;
  sandbox: 'read-only' | 'workspace-write';
  codexCli?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const codexCli = input.codexCli || 'codex';
  const args = codexExecArgs(input.sandbox);
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(Object.assign(new Error('codex exec cancelled before start'), { aborted: true, cancelled: true }));
      return;
    }
    const child = spawn(codexCli, args, { cwd: input.workspacePath, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateSpawnedProcessTree(child, 'SIGTERM');
    }, input.timeoutMs ?? 600_000);
    const onAbort = () => {
      aborted = true;
      terminateSpawnedProcessTree(child, 'SIGTERM');
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      if (aborted) reject(Object.assign(new Error('codex exec cancelled'), { aborted: true, cancelled: true }));
      else if (timedOut) reject(new Error(`codex exec timed out after ${input.timeoutMs ?? 600_000}ms`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`codex exec exited ${code}: ${stderr || stdout}`));
    });
    child.stdin.end(input.prompt);
  });
}

function terminateSpawnedProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill(signal));
    return;
  }
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

export function codexExecArgs(sandbox: 'read-only' | 'workspace-write') {
  return ['exec', '--sandbox', sandbox, '--ephemeral', '--skip-git-repo-check', '--color', 'never', '-'];
}

export function pipelineJobConfig(jenkinsfile: string, parameterDefinitions: JenkinsParameterDefinition[]): string {
  const parameters = validateParameterDefinitions(parameterDefinitions).map(renderParameterDefinition).join('\n');
  return `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <actions/>
  <description>Managed by AutoDevOps. Manual changes may be overwritten.</description>
  <keepDependencies>false</keepDependencies>
  <properties>
    <hudson.model.ParametersDefinitionProperty>
      <parameterDefinitions>
${parameters}
      </parameterDefinitions>
    </hudson.model.ParametersDefinitionProperty>
  </properties>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps">
    <script>${escapeXml(jenkinsfile)}</script>
    <sandbox>true</sandbox>
  </definition>
  <disabled>false</disabled>
</flow-definition>`;
}

function renderParameterDefinition(definition: JenkinsParameterDefinition) {
  const name = escapeXml(definition.name);
  const description = escapeXml(definition.description ?? 'Managed by AutoDevOps');
  if (definition.type === 'password') {
    return `        <hudson.model.PasswordParameterDefinition>
          <name>${name}</name>
          <description>${description}</description>
          <defaultValue/>
        </hudson.model.PasswordParameterDefinition>`;
  }
  if (definition.type === 'boolean') {
    return `        <hudson.model.BooleanParameterDefinition>
          <name>${name}</name>
          <description>${description}</description>
          <defaultValue>false</defaultValue>
        </hudson.model.BooleanParameterDefinition>`;
  }
  return `        <hudson.model.StringParameterDefinition>
          <name>${name}</name>
          <description>${description}</description>
          <defaultValue></defaultValue>
          <trim>true</trim>
        </hudson.model.StringParameterDefinition>`;
}

function validateParameterDefinitions(definitions: JenkinsParameterDefinition[]) {
  if (!definitions.length) throw new Error('Jenkins Pipeline jobs require at least one parameter definition');
  const names = new Set<string>();
  return definitions.map((definition) => {
    const name = definition.name.trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Unsafe Jenkins parameter name: ${definition.name}`);
    if (names.has(name)) throw new Error(`Duplicate Jenkins parameter definition: ${name}`);
    names.add(name);
    return { ...definition, name };
  });
}

function configuredParameterDefinitions(configXml: string) {
  const section = configXml.match(/<parameterDefinitions>([\s\S]*?)<\/parameterDefinitions>/)?.[1] ?? '';
  const definitions = new Map<string, JenkinsParameterDefinition['type']>();
  for (const match of section.matchAll(/<hudson\.model\.(String|Password|Boolean)ParameterDefinition>([\s\S]*?)<\/hudson\.model\.\1ParameterDefinition>/g)) {
    const name = match[2].match(/<name>([A-Z][A-Z0-9_]*)<\/name>/)?.[1];
    if (name) definitions.set(name, match[1].toLowerCase() as JenkinsParameterDefinition['type']);
  }
  return definitions;
}

function normalizeBuildStatus(value: string): JenkinsBuildWebhook['status'] {
  const upper = value.toUpperCase();
  if (upper === 'SUCCESS') return 'SUCCESS';
  if (upper === 'FAILURE' || upper === 'FAILED') return 'FAILURE';
  if (upper === 'ABORTED' || upper === 'CANCELLED') return 'ABORTED';
  return 'STARTED';
}

function normalizeStageStatus(value: string): NonNullable<JenkinsBuildWebhook['stages']>[number]['status'] {
  const upper = value.toUpperCase();
  if (upper === 'SUCCESS') return 'SUCCESS';
  if (upper === 'FAILURE' || upper === 'FAILED') return 'FAILURE';
  if (upper === 'ABORTED' || upper === 'CANCELLED') return 'ABORTED';
  return 'IN_PROGRESS';
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
}

function stringValue(value: unknown): string {
  return String(value ?? '').trim();
}

function optionalString(value: unknown): string | undefined {
  const text = stringValue(value);
  return text || undefined;
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
