import { normalizeEmail, text } from './util';

const ACTIVITY_FEED_LIMIT = 200;
const ACTIVITY_TITLES: Record<string, string> = {
  LOGIN_SUCCESS: 'Signed in',
  ACCESS_DENIED: 'Could not open something',
  ADD_STUDENT_TODO: 'Added a to-do',
  UPDATE_STUDENT_TODO: 'Edited a to-do',
  SET_ACTION_ITEM_DUE_DATE: 'Changed a due date',
  REPOSITION_STUDENT_TODO: 'Moved a to-do',
  UPDATE_ACTION_ITEM_STATUS: 'Updated a task',
  FORM_SUBMIT: 'Submitted a form',
  FORM_DRAFT: 'Saved a form draft',
  TICKET_CREATE: 'Sent a message',
  TICKET_REPLY: 'Sent a reply',
  TICKET_READ: 'Opened a message',
  TICKET_STATUS: 'Changed a message status',
  TICKET_SHARE: 'Changed who can see a message',
  NOTE_CREATE: 'Saved a note',
  SAVE_TODO_TEMPLATE: 'Saved a template task',
  DELETE_TODO_TEMPLATE: 'Removed a template task',
  APPLY_TODO_TEMPLATE: 'Added a template task to a student',
  SAVE_COHORT_DRIVE_SETTINGS: 'Saved cohort Drive settings',
  CHECK_COHORT_DRIVE_FOLDERS: 'Checked student Drive folders',
  SYNC_COHORT_DRIVE_FOLDERS: 'Updated student Drive folders',
};

export function activityFeed(email: string, records: Record<string, any>[], templates: Record<string, string>, tasks: Record<string, string>) {
  const actor = normalizeEmail(email);
  if (!actor) return emptyActivity('');
  const lookups = { templates, tasks };
  const collapsed: any[] = [];
  records.forEach((record) => {
    if (normalizeEmail(record.User) !== actor) return;
    const parsed = presentActivity(record, lookups);
    const previous = collapsed.length ? collapsed[collapsed.length - 1] : null;
    if (previous && previous.phase === 'REQUESTED' && (parsed.phase === 'SUCCEEDED' || parsed.phase === 'FAILED') && previous.action === parsed.action) {
      collapsed[collapsed.length - 1] = parsed;
      return;
    }
    collapsed.push(parsed);
  });
  collapsed.reverse();
  collapsed.forEach((entry, index) => {
    entry.id = `activity-${index}`;
    delete entry.phase;
  });
  const shown = collapsed.slice(0, ACTIVITY_FEED_LIMIT);
  return { actor, total: collapsed.length, truncated: collapsed.length > shown.length, counts: activityCounts(shown), entries: shown };
}

function emptyActivity(email: string) {
  return { actor: email, total: 0, truncated: false, counts: activityCounts([]), entries: [] };
}

function presentActivity(record: Record<string, any>, lookups: { templates: Record<string, string>; tasks: Record<string, string> }) {
  const rawAction = text(record.Action) || 'UNKNOWN';
  let phase = '';
  let action = rawAction;
  ['REQUESTED', 'SUCCEEDED', 'FAILED'].forEach((suffix) => {
    const marker = `_${suffix}`;
    if (rawAction.length > marker.length && rawAction.slice(-marker.length) === marker) {
      phase = suffix;
      action = rawAction.slice(0, -marker.length);
    }
  });
  const unpacked = unpackActivityPayload(record.Payload);
  const outcome = activityOutcome(phase, action);
  const taskTitle = lookups.tasks[text(unpacked.payload.taskId)] || '';
  const milestoneTitle = lookups.templates[text(unpacked.payload.milestoneId)] || lookups.templates[text(unpacked.payload.templateId)] || '';
  return {
    at: record.Timestamp ? String(record.Timestamp) : '',
    action,
    phase,
    outcome,
    kind: activityKind(action),
    title: activityTitle(action),
    summary: activitySummary(action, unpacked, taskTitle, milestoneTitle, outcome),
    details: activityDetails(unpacked, taskTitle, milestoneTitle, lookups),
  };
}

function unpackActivityPayload(value: unknown) {
  let payload = parseActivityPayload(value);
  const reason = text(payload.reason);
  if (payload.detail && typeof payload.detail === 'object' && !Array.isArray(payload.detail)) payload = payload.detail;
  return { payload, reason };
}

function parseActivityPayload(value: unknown): Record<string, any> {
  if (value && typeof value === 'object') return value as Record<string, any>;
  const raw = text(value);
  if (!raw) return {};
  if (raw.charAt(0) !== '{' && raw.charAt(0) !== '[') return { note: raw.slice(0, 500) };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { note: raw.slice(0, 500) };
    return parsed;
  } catch {
    return { note: raw.slice(0, 500) };
  }
}

function activityOutcome(phase: string, action: string) {
  if (phase === 'FAILED' || action === 'ACCESS_DENIED') return 'failed';
  if (phase === 'REQUESTED') return 'started';
  if (action === 'LOGIN_SUCCESS' || action === 'TICKET_READ') return 'info';
  return 'done';
}

function activityKind(action: string) {
  if (action === 'LOGIN_SUCCESS' || action === 'ACCESS_DENIED') return 'sign-in';
  if (action.indexOf('FORM_') === 0) return 'form';
  if (action.indexOf('TICKET_') === 0 || action === 'NOTE_CREATE') return 'question';
  if (action.indexOf('TODO') >= 0 || action === 'SET_ACTION_ITEM_DUE_DATE' || action === 'UPDATE_ACTION_ITEM_STATUS' || action === 'REPOSITION_STUDENT_TODO') return 'task';
  return 'other';
}

function activityTitle(action: string) {
  if (ACTIVITY_TITLES[action]) return ACTIVITY_TITLES[action];
  const words = String(action || '').toLowerCase().split('_').filter(Boolean);
  if (!words.length) return 'Activity';
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ` ${words.slice(1).join(' ')}` : '');
}

function activitySummary(action: string, unpacked: { payload: any; reason: string }, taskTitle: string, milestoneTitle: string, outcome: string) {
  if (outcome === 'failed' && unpacked.reason) return unpacked.reason;
  const payload = unpacked.payload;
  if (action === 'LOGIN_SUCCESS') return 'Opened the EE Hub';
  if (action === 'ACCESS_DENIED') return unpacked.reason || 'The EE Hub blocked this action';
  if (action === 'ADD_STUDENT_TODO') return 'Personal to-do';
  if (action === 'UPDATE_STUDENT_TODO' || action === 'SET_ACTION_ITEM_DUE_DATE' || action === 'REPOSITION_STUDENT_TODO') return taskTitle || 'Personal to-do';
  if (action === 'UPDATE_ACTION_ITEM_STATUS') {
    const status = text(payload.status);
    if (taskTitle && status) return `${taskTitle} · ${status}`;
    return taskTitle || status || 'Task status';
  }
  if (action === 'FORM_SUBMIT' || action === 'FORM_DRAFT') return milestoneTitle || text(payload.milestoneId) || 'Form';
  if (action === 'NOTE_CREATE') return 'Private note';
  if (action === 'TICKET_SHARE') return payload.shared ? 'Shared message' : 'Private note';
  if (action.indexOf('TICKET_') === 0) return text(payload.category) || 'Message';
  if (action === 'APPLY_TODO_TEMPLATE' || action === 'SAVE_TODO_TEMPLATE' || action === 'DELETE_TODO_TEMPLATE') return text(payload.title) || 'Template task';
  return milestoneTitle || taskTitle || '';
}

function activityDetails(unpacked: { payload: any; reason: string }, taskTitle: string, milestoneTitle: string, lookups: { tasks: Record<string, string> }) {
  const payload = unpacked.payload;
  const rows: { label: string; value: string }[] = [];
  function add(label: string, value: unknown) {
    const clean = Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean).join(', ') : text(value);
    if (!clean) return;
    rows.push({ label, value: clean });
  }
  add('Milestone', milestoneTitle);
  add('Task', taskTitle || payload.taskId);
  add('Placed beside', lookups.tasks[text(payload.targetTaskId)] || '');
  if (text(payload.position)) add('Placement', text(payload.position) === 'before' ? 'Before that task' : 'After that task');
  add('Status', payload.status);
  add('Category', payload.category);
  add('Sent to', activityRouteLabel(payload.route));
  add('Phase', payload.phaseId || payload.phase);
  add('Cohort', payload.cohort);
  add('Fields', payload.fields);
  if (payload.version !== undefined && payload.version !== '') add('Form version', payload.version);
  add('What happened', unpacked.reason);
  add('Note', payload.note);
  return rows;
}

function activityRouteLabel(route: unknown) {
  const value = text(route).toLowerCase();
  if (value === 'coordinator') return 'EE Coordinator';
  if (value === 'supervisor') return 'Supervisor';
  return text(route);
}

function activityCounts(entries: { kind: string }[]) {
  const counts: Record<string, number> = { all: entries.length, 'sign-in': 0, form: 0, question: 0, task: 0, other: 0 };
  entries.forEach((entry) => {
    if (!Object.prototype.hasOwnProperty.call(counts, entry.kind)) counts[entry.kind] = 0;
    counts[entry.kind] += 1;
  });
  return counts;
}
