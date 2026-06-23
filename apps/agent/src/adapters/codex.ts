import { runCodexExec } from '@autodevops/integrations';

export type CodexRunInput = {
  prompt: string;
  workspacePath: string;
  sandbox: 'read-only' | 'workspace-write';
  timeoutMs: number;
};

export interface CodexAdapter {
  run(input: CodexRunInput): Promise<{ stdout: string; stderr: string }>;
}

export class SystemCodexAdapter implements CodexAdapter {
  constructor(private readonly codexCli: string) {}

  run(input: CodexRunInput) {
    return runCodexExec({ ...input, codexCli: this.codexCli });
  }
}
