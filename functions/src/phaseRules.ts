import { HubError, text } from './util';

export interface PhaseLink {
  phaseId: string;
  prerequisitePhaseId: string;
}

export function validatePhasePrerequisites(records: PhaseLink[], phaseId: string, prerequisiteId: string, originalKey = ''): void {
  const id = text(phaseId);
  const prerequisite = text(prerequisiteId);
  if (prerequisite && prerequisite === id) throw new HubError('A phase cannot depend on itself.');
  const prerequisites: Record<string, string> = {};
  records.forEach((phase) => {
    prerequisites[text(phase.phaseId)] = text(phase.prerequisitePhaseId);
  });
  if (originalKey && originalKey !== id) delete prerequisites[originalKey];
  prerequisites[id] = prerequisite;
  if (prerequisite && !Object.prototype.hasOwnProperty.call(prerequisites, prerequisite)) {
    throw new HubError('The prerequisite phase does not exist.');
  }
  Object.keys(prerequisites).forEach((startId) => {
    const visited: Record<string, boolean> = {};
    let current = startId;
    while (current) {
      if (visited[current]) throw new HubError('Phase prerequisites cannot contain a cycle.');
      visited[current] = true;
      current = prerequisites[current] || '';
    }
  });
}
