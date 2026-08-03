import assert from 'node:assert/strict';
import test from 'node:test';
import { JenkinsClient, pipelineJobConfig, type JenkinsParameterDefinition } from '../packages/integrations/src/index.js';

const definitions: JenkinsParameterDefinition[] = [
  { name: 'PIPELINE_RUN_ID', type: 'string' },
  { name: 'RUNTIME_CONFIG_TOKEN', type: 'password' },
];

test('Jenkins Pipeline config declares parameters before the first build', () => {
  const xml = pipelineJobConfig("pipeline { stages { stage('Build') { steps { echo 'ok' } } } }", definitions);

  assert.match(xml, /hudson\.model\.ParametersDefinitionProperty/);
  assert.match(xml, /hudson\.model\.StringParameterDefinition/);
  assert.match(xml, /<name>PIPELINE_RUN_ID<\/name>/);
  assert.match(xml, /hudson\.model\.PasswordParameterDefinition/);
  assert.match(xml, /<name>RUNTIME_CONFIG_TOKEN<\/name>/);
  assert.match(xml, /echo 'ok'/);
});

test('Jenkins client creates, verifies, and parameter-triggers a new Pipeline job without a bootstrap build', async () => {
  const originalFetch = globalThis.fetch;
  let storedConfig = '';
  let triggerBody = '';
  const requests: Array<{ url: string; method: string; cookie?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    requests.push({ url, method, cookie: headers.get('cookie') ?? undefined });
    if (url.endsWith('/crumbIssuer/api/json')) {
      return new Response(JSON.stringify({ crumbRequestField: 'Jenkins-Crumb', crumb: 'crumb-value' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'JSESSIONID=session-value; Path=/; HttpOnly' },
      });
    }
    if (url.endsWith('/job/deploy/config.xml') && method === 'GET') {
      return storedConfig ? new Response(storedConfig, { status: 200 }) : new Response('missing', { status: 404 });
    }
    if (url.includes('/createItem?name=deploy') && method === 'POST') {
      storedConfig = String(init?.body ?? '');
      return new Response('', { status: 200 });
    }
    if (url.endsWith('/job/deploy/buildWithParameters') && method === 'POST') {
      triggerBody = String(init?.body ?? '');
      return new Response('', { status: 201, headers: { Location: 'http://jenkins/queue/item/1/' } });
    }
    return new Response('unexpected request', { status: 500 });
  };

  try {
    const client = new JenkinsClient({ baseUrl: 'http://jenkins', username: 'bot', apiToken: 'api-token' });
    await client.upsertPipelineJob('deploy', 'pipeline {}', definitions);
    const queue = await client.triggerBuild('deploy', { PIPELINE_RUN_ID: 'run-1', RUNTIME_CONFIG_TOKEN: 'secret-value' });

    assert.equal(queue.queueUrl, 'http://jenkins/queue/item/1/');
    assert.match(storedConfig, /<name>PIPELINE_RUN_ID<\/name>/);
    assert.match(storedConfig, /<name>RUNTIME_CONFIG_TOKEN<\/name>/);
    assert.doesNotMatch(storedConfig, /secret-value/);
    assert.equal(triggerBody, 'PIPELINE_RUN_ID=run-1&RUNTIME_CONFIG_TOKEN=secret-value');
    assert.ok(requests.some((request) => request.cookie === 'JSESSIONID=session-value'));
    assert.ok(requests.every((request) => !request.url.includes('secret-value')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Jenkins Pipeline config rejects unsafe or duplicate parameter names', () => {
  assert.throws(() => pipelineJobConfig('pipeline {}', [{ name: 'bad-name', type: 'string' }]), /Unsafe Jenkins parameter name/);
  assert.throws(() => pipelineJobConfig('pipeline {}', [definitions[0], definitions[0]]), /Duplicate Jenkins parameter definition/);
});
