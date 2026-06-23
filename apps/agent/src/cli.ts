import { generatePm2Config, loadAgentConfig } from './config.js';
import { versionInfo } from './identity.js';
import { ReadinessService } from './readiness.js';
import { createSystemRuntime } from './runtime.js';

export async function runCli(args = process.argv.slice(2)) {
  const command = commandFromArgs(args);
  if (command === 'version') {
    const info = await versionInfo();
    console.log(args.includes('--json') ? JSON.stringify(info, null, 2) : `autodevops-agent ${info.displayVersion} protocol=${info.protocolVersion}`);
    return 0;
  }

  const config = loadAgentConfig();
  if (command === 'pm2-config') {
    console.log(JSON.stringify(generatePm2Config(config), null, 2));
    return 0;
  }
  if (command === 'diagnose') {
    const diagnostics = await new ReadinessService(config).diagnostics();
    console.log(JSON.stringify(diagnostics, null, 2));
    return diagnostics.readiness.status === 'blocked' ? 1 : 0;
  }
  await createSystemRuntime(config).run();
  return 0;
}

function commandFromArgs(args: string[]) {
  if (args.includes('--version') || args.includes('-v') || args[0] === 'version') return 'version';
  if (args[0] === 'diagnose' || args.includes('--diagnose')) return 'diagnose';
  if (args[0] === 'pm2-config' || args.includes('--pm2-config')) return 'pm2-config';
  return 'run';
}

runCli().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
