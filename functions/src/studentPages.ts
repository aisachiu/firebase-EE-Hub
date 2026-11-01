import { App, audited, requireAdmin } from './session';
import { Doc, HubError, nowIso, toBoolean } from './util';

export const STUDENT_PAGE_KEYS = ['document', 'journey', 'calendar', 'supervisor', 'chat'] as const;

export type StudentPageKey = typeof STUDENT_PAGE_KEYS[number];

export const STUDENT_UI_SETTINGS = 'studentUI';

/** Missing flags stay visible so an empty settings document does not blank My EE. */
export function normalizeStudentPages(value: unknown): Record<StudentPageKey, boolean> {
  const record = value && typeof value === 'object' ? value as Doc : {};
  const nested = record.pages && typeof record.pages === 'object' ? record.pages as Doc : null;
  const source = nested || record;
  const pages = {} as Record<StudentPageKey, boolean>;
  STUDENT_PAGE_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === '' || source[key] === null || source[key] === undefined) {
      pages[key] = true;
      return;
    }
    pages[key] = toBoolean(source[key]);
  });
  return pages;
}

export async function readStudentPageFlags(app: App): Promise<Record<StudentPageKey, boolean>> {
  if (typeof app.store.getSettings !== 'function') return normalizeStudentPages(null);
  const saved = await app.store.getSettings(STUDENT_UI_SETTINGS);
  return normalizeStudentPages(saved);
}

export async function getStudentPageSettings(app: App) {
  await requireAdmin(app, 'VIEW_STUDENT_PAGE_SETTINGS');
  return { pages: await readStudentPageFlags(app) };
}

export async function saveStudentPageSettings(app: App, input: unknown) {
  const user = await requireAdmin(app, 'SAVE_STUDENT_PAGE_SETTINGS');
  const pages = normalizeStudentPages(input);
  if (STUDENT_PAGE_KEYS.every((key) => pages[key] === false)) {
    throw new HubError('Leave at least one student page visible.');
  }
  return audited(app, user, 'SAVE_STUDENT_PAGE_SETTINGS', { pages }, async () => {
    await app.store.setSettings(STUDENT_UI_SETTINGS, {
      pages,
      updatedAt: nowIso(),
      updatedBy: user.email,
    });
    return { pages };
  });
}
