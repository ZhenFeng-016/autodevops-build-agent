import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Project } from '@zhenfengxx/contracts';
import { createRuntimeContract, inspectRepository } from '@zhenfengxx/repo-inspector';

test('Oak runtime config inspection derives postgres and build-time redis requirements from safe templates', () => {
  const root = createFixture();
  try {
    write(root, 'configuration/postgres.example.json', JSON.stringify({ host: '127.0.0.1', user: 'postgres', password: '<required>', database: 'fixture', port: 5432, max: 5 }));
    write(root, 'configuration/redis.example.json', JSON.stringify({ host: '127.0.0.1', port: 6379, password: '<required>', db: 0 }));
    write(root, 'src/config/connector/index.backend.ts', "import redisConfig from '../../../../configuration/redis.json'; export default redisConfig;\n");
    write(root, '.gitignore', 'configuration/postgres*.json\nconfiguration/redis*.json\n!configuration/*.example.json\n');
    git(root, 'add', '.');

    const inspection = inspectRepository('project-1', root);
    const postgres = inspection.oak.runtimeConfigRequirements?.find((item) => item.kind === 'oak_postgres');
    const redis = inspection.oak.runtimeConfigRequirements?.find((item) => item.kind === 'oak_redis');

    assert.ok(postgres);
    assert.equal(postgres.requiredAt, 'runtime');
    assert.equal(postgres.gitIgnored, true);
    assert.equal(postgres.trackedRuntimeFile, false);
    assert.deepEqual(postgres.templateKeys, ['database', 'host', 'max', 'password', 'port', 'user']);

    assert.ok(redis);
    assert.equal(redis.requiredAt, 'build_and_runtime');
    assert.equal(redis.gitIgnored, true);
    assert.match(redis.evidence.join('\n'), /runtime-config-import:src\/config\/connector\/index\.backend\.ts/);

    const contract = createRuntimeContract(project(), inspection);
    assert.equal(contract.database.connectionSource, 'oak_configuration');
    assert.deepEqual(contract.database.configurationFiles, ['configuration/postgres.json']);
    assert.equal(contract.runtimeConfig?.requirements.length, 2);
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Oak runtime config inspection reports a tracked real config without reading its values', () => {
  const root = createFixture();
  try {
    write(root, 'configuration/postgres.example.json', JSON.stringify({ host: '127.0.0.1', user: 'postgres', password: '<required>', database: 'fixture' }));
    write(root, 'configuration/postgres.json', JSON.stringify({ opaque: 'do-not-inspect' }));
    git(root, 'add', '.');

    const requirement = inspectRepository('project-1', root).oak.runtimeConfigRequirements?.find((item) => item.kind === 'oak_postgres');
    assert.ok(requirement);
    assert.equal(requirement.existingRuntimeFile, true);
    assert.equal(requirement.trackedRuntimeFile, true);
    assert.equal(requirement.gitIgnored, false);
    assert.deepEqual(requirement.templateKeys, ['database', 'host', 'password', 'user']);
    assert.doesNotMatch(JSON.stringify(requirement), /do-not-inspect/);
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'autodevops-runtime-config-'));
  write(root, 'package.json', JSON.stringify({ name: 'fixture', dependencies: { 'oak-backend-base': '^1.0.0' } }));
  git(root, 'init', '--quiet');
  return root;
}

function write(root: string, path: string, content: string) {
  const fullPath = join(root, path);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

function git(root: string, ...args: string[]) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore', windowsHide: true });
}

function project(): Project {
  return {
    id: 'project-1',
    name: 'fixture',
    repositoryUrl: 'https://example.test/fixture.git',
    defaultBranch: 'main',
    environment: 'prod',
  };
}
