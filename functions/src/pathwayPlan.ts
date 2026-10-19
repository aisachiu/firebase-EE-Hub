import { Doc, HubError, text, toBoolean } from './util';

export type AnchorMode = 'adjust' | 'move' | 'release';

export function assertSingleMilestoneAnchor(records: { isAnchor?: unknown }[]): void {
  const anchors = records.filter((row) => toBoolean(row.isAnchor));
  if (anchors.length > 1) throw new HubError('Only one milestone can be the anchor.');
}

export function reanchorMilestones(records: Doc[], milestoneId: string, mode: AnchorMode): { milestones: Doc[]; deltaDays: number } {
  const id = text(milestoneId);
  const target = records.find((row) => text(row.milestoneId) === id);
  if (!target) throw new HubError('Milestone not found.');
  if (mode === 'release') {
    return {
      deltaDays: 0,
      milestones: records.map((row) => (text(row.milestoneId) === id ? { ...row, isAnchor: false } : { ...row })),
    };
  }
  if (mode !== 'adjust' && mode !== 'move') {
    throw new HubError('Choose whether to keep the dates or use the existing anchor date.');
  }
  const deltaDays = Number(target.offsetDays) || 0;
  const milestones = records.map((row) => {
    const next = { ...row };
    const mine = text(next.milestoneId) === id;
    next.isAnchor = mine;
    if (mode === 'adjust') next.offsetDays = (Number(next.offsetDays) || 0) - deltaDays;
    if (mode === 'move' && mine) next.offsetDays = 0;
    return next;
  });
  assertSingleMilestoneAnchor(milestones);
  return { milestones, deltaDays: mode === 'adjust' ? deltaDays : 0 };
}
