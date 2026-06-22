import { v7 as uuidv7 } from 'uuid';

export function newEntityId() {
  return uuidv7();
}

export function generateCodexFixBranchName(input: { projectId: string; incidentId: string; fixId: string }) {
  return `autodevops/fix/${gitBranchSegment(input.projectId)}/${gitBranchSegment(input.incidentId)}/${gitBranchSegment(input.fixId).slice(-12)}`;
}

function gitBranchSegment(value: string) {
  const segment = String(value || 'unknown').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').replace(/\.+$/g, '');
  return segment || 'unknown';
}
