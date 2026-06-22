import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILENAMES = ['.env.agent', '.env.local', '.env'];

loadLocalEnv();

function loadLocalEnv() {
  const roots = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const envFile of findEnvFiles(root)) {
      if (seen.has(envFile)) continue;
      seen.add(envFile);
      loadEnvFile(envFile);
    }
  }
}

function findEnvFiles(start: string) {
  const files: string[] = [];
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    for (const filename of ENV_FILENAMES) {
      const candidate = join(current, filename);
      if (existsSync(candidate)) files.push(candidate);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files;
}

function loadEnvFile(path: string) {
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(match[2] ?? '');
  }
}

function parseEnvValue(raw: string) {
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
}
