import { findPlacement, readTemplates } from './roster';
import { App, audited, deny, requireUser } from './session';
import { Doc, HubError, normalizeEmail, nowIso, text, toBoolean } from './util';

export const REFLECTION_BODY_LIMIT = 8000;
export const VIVA_NOTE_ID = 'viva-voce';

const NOTE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface ReflectionSlot {
  noteId: string;
  title: string;
  kind: 'meeting' | 'viva';
}

export interface ReflectionNote {
  noteId: string;
  title: string;
  kind: 'meeting' | 'viva';
  body: string;
  complete: boolean;
  date: string;
  docLink: string;
  updatedAt: string;
}

type TemplateLike = { milestoneId?: unknown; type?: unknown; title?: unknown; milestoneTitle?: unknown };

export function reflectionSlots(templates: TemplateLike[]): ReflectionSlot[] {
  const slots: ReflectionSlot[] = [];
  (templates || []).forEach((template) => {
    if (text(template?.type).toLowerCase() !== 'meeting') return;
    const noteId = text(template.milestoneId);
    if (!NOTE_ID.test(noteId) || slots.some((slot) => slot.noteId === noteId)) return;
    const title = text(template.title) || text(template.milestoneTitle) || 'Meeting';
    slots.push({ noteId, title, kind: /viva\s*voce/i.test(title) ? 'viva' : 'meeting' });
  });
  if (!slots.some((slot) => slot.kind === 'viva' || slot.noteId === VIVA_NOTE_ID)) {
    slots.push({ noteId: VIVA_NOTE_ID, title: 'Viva Voce', kind: 'viva' });
  }
  return slots;
}

export function reflectionDocLink(value: unknown, strict: boolean): string {
  const raw = text(value);
  if (!raw) return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    if (strict) throw new HubError('Paste a Google Doc link.');
    return '';
  }
  const doc = parsed.protocol === 'https:' && parsed.hostname === 'docs.google.com' && /^\/document\/d\/[^/]+/.test(parsed.pathname);
  if (!doc) {
    if (strict) throw new HubError('Paste a Google Doc link.');
    return '';
  }
  return parsed.href;
}

export function reflectionDate(value: unknown, strict: boolean): string {
  const raw = text(value);
  if (!raw) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    if (strict) throw new HubError('Choose a valid date.');
    return '';
  }
  const parts = raw.split('-').map((part) => Number(part));
  const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const real = utc.getUTCFullYear() === parts[0] && utc.getUTCMonth() === parts[1] - 1 && utc.getUTCDate() === parts[2];
  if (!real) {
    if (strict) throw new HubError('Choose a valid date.');
    return '';
  }
  return raw;
}

export function reflectionBody(value: unknown): string {
  if (value === null || value === undefined) return '';
  const body = String(value).replace(/\r\n/g, '\n');
  if (body.length > REFLECTION_BODY_LIMIT) throw new HubError('Notes must be 8,000 characters or fewer.');
  return body;
}

export function presentReflectionNotes(slots: ReflectionSlot[], stored: Doc[]): ReflectionNote[] {
  const byId: Record<string, Doc> = {};
  (stored || []).forEach((row) => {
    const id = text(row?.noteId);
    if (id) byId[id] = row;
  });
  return slots.map((slot) => {
    const row = byId[slot.noteId] || {};
    const body = row.body === null || row.body === undefined ? '' : String(row.body).replace(/\r\n/g, '\n');
    return {
      noteId: slot.noteId,
      title: slot.title,
      kind: slot.kind,
      body: body.slice(0, REFLECTION_BODY_LIMIT),
      complete: toBoolean(row.complete),
      date: reflectionDate(row.date, false),
      docLink: reflectionDocLink(row.docLink, false),
      updatedAt: text(row.updatedAt),
    };
  });
}

export async function loadReflectionNotes(app: App, cohortId: string, email: string, templates: TemplateLike[]): Promise<ReflectionNote[]> {
  const slots = reflectionSlots(templates);
  const id = normalizeEmail(email);
  if (!cohortId || !id || typeof app.store.listReflectionNotes !== 'function') return presentReflectionNotes(slots, []);
  const stored = await app.store.listReflectionNotes(cohortId, id);
  return presentReflectionNotes(slots, stored);
}

export async function saveReflectionNote(app: App, noteId: unknown, patch: unknown) {
  const user = await requireUser(app, 'SAVE_REFLECTION_NOTE');
  if (user.role !== 'student') return deny(app, user, 'SAVE_REFLECTION_NOTE', 'Student access required.');
  const placement = await findPlacement(app, user.email);
  if (!placement?.cohortId) throw new HubError('You are not on a cohort roster yet.');
  const slots = reflectionSlots(await readTemplates(app, placement.cohortId));
  const id = text(noteId);
  const slot = slots.find((item) => item.noteId === id);
  if (!slot) throw new HubError('That note is not part of your meetings.');
  const incoming = patch && typeof patch === 'object' ? patch as Doc : {};
  const body = reflectionBody(incoming.body);
  const date = reflectionDate(incoming.date, true);
  const docLink = reflectionDocLink(incoming.docLink, true);
  const complete = toBoolean(incoming.complete);
  return audited(app, user, 'SAVE_REFLECTION_NOTE', { noteId: id, cohort: placement.cohortId }, async () => {
    const updatedAt = nowIso();
    const stored: Doc = {
      noteId: id,
      title: slot.title,
      kind: slot.kind,
      body,
      complete,
      date,
      docLink,
      updatedAt,
      updatedBy: user.email,
    };
    await app.store.setReflectionNote(placement.cohortId, user.email, id, stored);
    return {
      noteId: id,
      title: slot.title,
      kind: slot.kind,
      body,
      complete,
      date,
      docLink,
      updatedAt,
    };
  });
}
