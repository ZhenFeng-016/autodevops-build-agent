import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PROTOCOL_VERSION, type AgentRegistrationRequest } from '@zhenfengxx/contracts';
import { stringValue } from './common.js';

declare const __AUTODEVOPS_AGENT_VERSION__: string;
declare const __AUTODEVOPS_AGENT_REVISION__: string;

const execFileAsync = promisify(execFile);
const bundledVersion = typeof __AUTODEVOPS_AGENT_VERSION__ !== 'undefined' ? __AUTODEVOPS_AGENT_VERSION__ : undefined;
const bundledRevision = typeof __AUTODEVOPS_AGENT_REVISION__ !== 'undefined' ? __AUTODEVOPS_AGENT_REVISION__ : undefined;

export async function protocolIdentity(): Promise<Pick<AgentRegistrationRequest, 'agentVersion' | 'buildRevision' | 'protocolVersion' | 'supportedProtocolVersions'>> {
  const legacyVersion = (await agentVersion()) ?? 'development';
  const [legacyPackageVersion, legacyRevision] = legacyVersion.split('+', 2);
  return {
    agentVersion: stringValue(process.env.AUTODEVOPS_AGENT_PACKAGE_VERSION) || bundledVersion || legacyPackageVersion,
    buildRevision: stringValue(process.env.AUTODEVOPS_BUILD_REVISION) || bundledRevision || legacyRevision || await gitHead(process.cwd()).catch(() => 'development'),
    protocolVersion: PROTOCOL_VERSION,
    supportedProtocolVersions: [PROTOCOL_VERSION],
  };
}

export async function versionInfo() {
  const identity = await protocolIdentity();
  return {
    name: '@zhenfengxx/build-agent',
    agentVersion: identity.agentVersion,
    buildRevision: identity.buildRevision,
    protocolVersion: identity.protocolVersion,
    supportedProtocolVersions: identity.supportedProtocolVersions,
    displayVersion: `${identity.agentVersion}+${identity.buildRevision}`,
  };
}

export async function gitHead(cwd: string) {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd, timeout: 10_000 });
  return stdout.trim();
}

async function agentVersion() {
  const configured = stringValue(process.env.AUTODEVOPS_AGENT_VERSION);
  if (configured) return configured;
  if (bundledVersion) return `${bundledVersion}+${bundledRevision ?? 'unknown'}`;
  const packagedVersionFile = join(process.cwd(), '.autodevops-version');
  if (existsSync(packagedVersionFile)) return readFileSync(packagedVersionFile, 'utf8').trim() || undefined;
  return gitHead(process.cwd()).catch(() => undefined);
}
