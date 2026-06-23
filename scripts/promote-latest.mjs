import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const packages = [
  '@zhenfengxx/contracts',
  '@zhenfengxx/agent-sdk',
  '@zhenfengxx/repo-inspector',
  '@zhenfengxx/build-agent',
];
const registry = 'https://registry.npmjs.org';
const version = process.argv.find((argument) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(argument));
const checkOnly = process.argv.includes('--check');
const npmCli = process.env.npm_execpath;

if (!version) throw new Error('Usage: npm run release:promote -- <version> [--check]');
if (!npmCli) throw new Error('npm_execpath is required; run through npm run release:promote');

function npm(args) {
  return execFileSync(process.execPath, [npmCli, ...args, `--registry=${registry}`], { encoding: 'utf8' }).trim();
}

if (!checkOnly) {
  if (process.env.GITHUB_ACTIONS && !process.env.NODE_AUTH_TOKEN) {
    throw new Error(
      'NPM_PROMOTE_TOKEN GitHub environment secret is required because npm trusted publishing does not support npm dist-tag add',
    );
  }
  try {
    const identity = npm(['whoami']);
    if (!identity) throw new Error('npm whoami returned an empty identity');
    console.log(`Authenticated as ${identity}`);
  } catch (error) {
    throw new Error('npm authentication is required before promoting packages. Run npm login locally, or configure NPM_PROMOTE_TOKEN in GitHub Actions.');
  }
}

for (const packageName of packages) {
  const tags = JSON.parse(npm(['view', packageName, 'dist-tags', '--json']));
  assert.equal(tags.next, version, `${packageName} next does not point to ${version}`);
  const publishedVersion = JSON.parse(npm(['view', `${packageName}@${version}`, 'version', '--json']));
  assert.equal(publishedVersion, version, `${packageName}@${version} is not published`);
  if (!checkOnly) npm(['dist-tag', 'add', `${packageName}@${version}`, 'latest']);
  const verifiedTags = checkOnly ? tags : JSON.parse(npm(['view', packageName, 'dist-tags', '--json']));
  if (!checkOnly) assert.equal(verifiedTags.latest, version, `${packageName} latest promotion failed`);
  console.log(`${packageName}@${version}: ${checkOnly ? 'eligible' : 'promoted'} (${JSON.stringify(verifiedTags)})`);
}
