import { readFileSync } from 'node:fs';

const publishWorkflow = readFileSync('.github/workflows/publish-npm-packages.yml', 'utf8');
const promoteWorkflow = readFileSync('.github/workflows/promote-npm-latest.yml', 'utf8');
const versionWorkflow = readFileSync('.github/workflows/version-packages.yml', 'utf8');
const changesetConfig = JSON.parse(readFileSync('.changeset/config.json', 'utf8'));

const requiredPublishFragments = [
  'workflow_dispatch:',
  'id-token: write',
  'environment: npm',
  'actions/checkout@v7',
  'actions/setup-node@v6',
  'node-version: 24',
  'registry-url: https://registry.npmjs.org',
  'package-manager-cache: false',
  'npm run ci',
  'npm run release:next',
];

for (const fragment of requiredPublishFragments) {
  if (!publishWorkflow.includes(fragment)) {
    throw new Error(`publish workflow is missing required policy: ${fragment}`);
  }
}

for (const forbidden of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', '_authToken', 'npm_token', 'cache: npm']) {
  if (publishWorkflow.includes(forbidden)) {
    throw new Error(`publish workflow must not use a long-lived npm credential: ${forbidden}`);
  }
  if (promoteWorkflow.includes(forbidden)) {
    throw new Error(`promote workflow must not use a long-lived npm credential: ${forbidden}`);
  }
}

const requiredPromoteFragments = [
  'workflow_dispatch:',
  'id-token: write',
  'environment: npm',
  'actions/checkout@v7',
  'actions/setup-node@v6',
  'node-version: 24',
  'registry-url: https://registry.npmjs.org',
  'package-manager-cache: false',
  'npm run release:promote -- ${{ inputs.version }} --check',
  'npm run release:promote -- ${{ inputs.version }}',
  'npm run release:verify -- ${{ inputs.version }}',
];

for (const fragment of requiredPromoteFragments) {
  if (!promoteWorkflow.includes(fragment)) {
    throw new Error(`promote workflow is missing required policy: ${fragment}`);
  }
}

for (const fragment of ['pull-requests: write', 'changesets/action@v1', 'secrets.GITHUB_TOKEN']) {
  if (!versionWorkflow.includes(fragment)) {
    throw new Error(`version workflow is missing required policy: ${fragment}`);
  }
}

const publicPackages = [
  '@zhenfengxx/contracts',
  '@zhenfengxx/agent-sdk',
  '@zhenfengxx/repo-inspector',
  '@zhenfengxx/build-agent',
];

if (changesetConfig.baseBranch !== 'main' || changesetConfig.access !== 'public') {
  throw new Error('Changesets must target main and public npm packages');
}

const fixed = changesetConfig.fixed.find((group) => publicPackages.every((name) => group.includes(name)));
if (!fixed || fixed.length !== publicPackages.length) {
  throw new Error('all four public packages must remain in one fixed release group');
}

console.log('Release policy check passed: OIDC-only publish, guarded version PR, fixed public package group');
