import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbiddenNames = tracked.filter((path) => /(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(path));
if (forbiddenNames.length) throw new Error(`forbidden credential files are tracked: ${forbiddenNames.join(', ')}`);

const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['GitHub token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['npm auth config', /\/\/_authToken\s*=\s*[^$\s{][^\s]*/],
];
const findings = [];
for (const path of tracked) {
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { continue; }
  for (const [label, pattern] of patterns) if (pattern.test(content)) findings.push(`${path}: ${label}`);
}
if (findings.length) throw new Error(`credential scan failed:\n${findings.join('\n')}`);
console.log(`Credential scan passed for ${tracked.length} tracked files`);
