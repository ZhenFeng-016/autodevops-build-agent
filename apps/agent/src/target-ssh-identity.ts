import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { AgentConfig } from './config.js';

export const AGENT_FEATURES = ['server.ssh.test'] as const;

export function targetSshIdentity(config: AgentConfig) {
  const publicKeyPath = config.targetSshKeyPath ? `${config.targetSshKeyPath}.pub` : undefined;
  if (!publicKeyPath || !existsSync(publicKeyPath)) return undefined;
  const publicKey = readFileSync(publicKeyPath, 'utf8').trim();
  if (!/^ssh-(?:ed25519|rsa|ecdsa-)/.test(publicKey)) return undefined;
  const keyBlob = publicKey.split(/\s+/)[1];
  if (!keyBlob) return undefined;
  return {
    publicKey,
    fingerprint: `SHA256:${createHash('sha256').update(Buffer.from(keyBlob, 'base64')).digest('base64').replace(/=+$/, '')}`,
  };
}
