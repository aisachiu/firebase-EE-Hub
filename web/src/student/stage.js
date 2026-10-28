/** Pathway stage for a student home. Completion of official milestones, not a model. */
export function pathwayStage(home) {
  const templates = (home && home.templates) || [];
  const total = templates.length;
  if (!total) return 'early';
  const done = ((home && home.actionItems) || []).filter(function(item) {
    return item && item.CreatorType === 'System' && item.Status === 'Completed';
  }).length;
  const ratio = done / total;
  if (ratio < 1 / 3) return 'early';
  if (ratio < 2 / 3) return 'mid';
  return 'late';
}

/**
 * Slot is where the parent view places the module.
 * hidden drops it. Anything other than primary goes in the secondary stack.
 * Research stays on Journey in every stage so published resources are not orphaned.
 */
export const STAGE_LAYOUTS = {
  document: {
    early: [
      { id: 'document', slot: 'primary' },
      { id: 'milestones', slot: 'secondary' },
      { id: 'research', slot: 'compact' },
    ],
    mid: [
      { id: 'document', slot: 'primary' },
      { id: 'milestones', slot: 'compact' },
    ],
    late: [
      { id: 'document', slot: 'primary' },
      { id: 'communication', slot: 'compact' },
    ],
  },
  journey: {
    early: [
      { id: 'milestones', slot: 'primary' },
      { id: 'research', slot: 'secondary' },
      { id: 'meetingNotes', slot: 'secondary' },
    ],
    mid: [
      { id: 'milestones', slot: 'primary' },
      { id: 'meetingNotes', slot: 'secondary' },
      { id: 'research', slot: 'secondary' },
    ],
    late: [
      { id: 'milestones', slot: 'primary' },
      { id: 'meetingNotes', slot: 'secondary' },
      { id: 'research', slot: 'compact' },
    ],
  },
  supervisor: {
    early: [
      { id: 'supervisor', slot: 'primary' },
      { id: 'communication', slot: 'primary' },
      { id: 'meetingNotes', slot: 'compact' },
    ],
    mid: [
      { id: 'communication', slot: 'primary' },
      { id: 'supervisor', slot: 'primary' },
      { id: 'meetingNotes', slot: 'secondary' },
    ],
    late: [
      { id: 'communication', slot: 'primary' },
      { id: 'supervisor', slot: 'secondary' },
      { id: 'milestones', slot: 'compact' },
    ],
  },
};

export function modulesFor(view, stage) {
  const layouts = STAGE_LAYOUTS[view] || STAGE_LAYOUTS.journey;
  const rows = layouts[stage] || layouts.early;
  return rows.map(function(entry) { return { id: entry.id, slot: entry.slot }; });
}

/** Primary column, then secondary stack. Hidden entries are omitted. Order follows the stage config. */
export function groupModules(entries) {
  const primary = [];
  const secondary = [];
  (entries || []).forEach(function(entry) {
    if (!entry || entry.slot === 'hidden') return;
    if (entry.slot === 'primary') primary.push(entry);
    else secondary.push(entry);
  });
  return { primary: primary, secondary: secondary };
}
