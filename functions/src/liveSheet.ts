import { requireDriveActor } from './driveAccount';
import {
  columnMappingsFrom,
  gridHeaderNames,
  indexLiveRoster,
  liveLinkProblems,
  liveMappingProblems,
  liveSheetLinked,
  mergeDetected,
  mergeLiveChoiceRow,
  parseLiveSheet,
  resolveLiveStudent,
  settingsForLiveLink,
  settingsFromDoc,
  workspaceFromDoc,
} from './allocationPure';
import { requireCohort } from './roster';
import { App, audited, requireAdmin } from './session';
import { spreadsheetIdFrom } from './sheetImport';
import { listWorkbookTabs, openGoogleWorkbook, readWorkbookTab, SheetWorkbook } from './sheetSync';
import { AllocationOp } from './store';
import { canonicalStudentEmail, canonicalStudentNumber } from './studentIdentity';
import { Doc, HubError, normalizeEmail, nowIso, text } from './util';

const ROW_LIMIT = 5000;
const WARNING_LIMIT = 40;

interface LiveDeps {
  workbook?: SheetWorkbook;
}

export interface LiveSheetTabs {
  cohortId: string;
  spreadsheetId: string;
  url: string;
  tabs: string[];
}

export interface LiveSheetHeaders {
  spreadsheetId: string;
  sheetName: string;
  headers: string[];
}

export interface LiveResyncResult {
  cohortId: string;
  spreadsheetId: string;
  sheetName: string;
  incoming: number;
  matched: number;
  skipped: number;
  updated: number;
  warnings: string[];
}

export async function listLiveSheetTabs(app: App, cohortId: unknown, source: unknown, deps?: LiveDeps): Promise<LiveSheetTabs> {
  await requireAdmin(app, 'LIST_LIVE_SHEET_TABS');
  const cohort = await requireCohort(app, text(cohortId));
  const spreadsheetId = spreadsheetIdOf(source);
  const workbook = await workbookFor(app, deps);
  const tabs = await listWorkbookTabs(workbook, spreadsheetId);
  return { cohortId: cohort.id, spreadsheetId, url: sheetUrl(source, spreadsheetId), tabs };
}

export async function getLiveSheetHeaders(app: App, cohortId: unknown, source: unknown, sheetName: unknown, deps?: LiveDeps): Promise<LiveSheetHeaders> {
  await requireAdmin(app, 'GET_LIVE_SHEET_HEADERS');
  await requireCohort(app, text(cohortId));
  const spreadsheetId = spreadsheetIdOf(source);
  const title = text(sheetName);
  if (!title) throw new HubError('Choose a sheet tab.');
  const workbook = await workbookFor(app, deps);
  const grid = await readWorkbookTab(workbook, spreadsheetId, title);
  return { spreadsheetId, sheetName: grid.title || title, headers: gridHeaderNames(grid) };
}

export async function saveLiveSheetLink(app: App, cohortId: unknown, link: unknown, deps?: LiveDeps) {
  const user = await requireAdmin(app, 'SAVE_LIVE_SHEET_LINK');
  const cohort = await requireCohort(app, text(cohortId));
  const payload = link && typeof link === 'object' ? link as Doc : {};
  const url = text(payload.url || payload.liveSheetUrl);
  const sheetName = text(payload.sheetName || payload.liveSheetTab);
  if (!url) throw new HubError('Enter a Google Sheet URL.');
  if (!sheetName) throw new HubError('Choose a sheet tab.');
  const spreadsheetId = spreadsheetIdOf(url);
  const mappings = columnMappingsFrom(payload.columnMappings);
  return audited(app, user, 'SAVE_LIVE_SHEET_LINK', { cohortId: cohort.id, spreadsheetId, sheetName }, async () => {
    const workbook = await workbookFor(app, deps);
    const grid = await readWorkbookTab(workbook, spreadsheetId, sheetName);
    const headers = gridHeaderNames(grid);
    const problems = liveLinkProblems(mappings, headers);
    if (problems.length) throw new HubError(problems[0]);
    const current = settingsFromDoc(await app.store.getAllocationConfig(cohort.id));
    const next = settingsForLiveLink(current, url, spreadsheetId, grid.title || sheetName, mappings);
    await app.store.setAllocationConfig(cohort.id, next);
    return next;
  });
}

export async function resyncLiveChoiceData(app: App, cohortId: unknown, deps?: LiveDeps): Promise<LiveResyncResult> {
  const user = await requireAdmin(app, 'RESYNC_LIVE_CHOICE_DATA');
  const cohort = await requireCohort(app, text(cohortId));
  return audited(app, user, 'RESYNC_LIVE_CHOICE_DATA', { cohortId: cohort.id }, async () => {
    const settings = settingsFromDoc(await app.store.getAllocationConfig(cohort.id));
    if (!liveSheetLinked(settings)) throw new HubError('Link a live Google Sheet before resyncing choice data.');
    const mappingProblems = liveMappingProblems(settings.columnMappings);
    if (mappingProblems.length) throw new HubError(mappingProblems[0]);
    const workbook = await workbookFor(app, deps);
    const grid = await readWorkbookTab(workbook, settings.spreadsheetId, settings.sheetName || settings.liveSheetTab);
    const headers = gridHeaderNames(grid);
    const problems = liveLinkProblems(settings.columnMappings, headers);
    if (problems.length) throw new HubError(problems[0]);
    const parsed = parseLiveSheet(grid, settings.columnMappings);
    if (parsed.rows.length > ROW_LIMIT) throw new HubError(`This sheet has more than ${ROW_LIMIT} data rows.`);
    const members = await app.store.listMembers(cohort.id);
    const index = indexLiveRoster(members.map((member) => ({
      studentId: normalizeEmail(member.StudentId),
      studentNumber: canonicalStudentNumber(member),
      studentEmail: canonicalStudentEmail(member),
    })));
    const existingDocs = await app.store.listWorkspace(cohort.id);
    const existing = new Map(existingDocs.map((doc) => [normalizeEmail(doc.studentId || doc.id), doc]));
    const now = nowIso();
    const warnings = parsed.warnings.slice();
    const seen = new Set<string>();
    let skipped = 0;
    const ops: AllocationOp[] = [];
    parsed.rows.forEach((row) => {
      const match = resolveLiveStudent(row, index, settings.columnMappings);
      if (!match.studentId) {
        skipped += 1;
        warnings.push(`${grid.title} row ${row.line}: ${match.warning}`);
        return;
      }
      if (seen.has(match.studentId)) warnings.push(`${grid.title} repeats ${match.studentId}. The last row is kept.`);
      seen.add(match.studentId);
      const priorDoc = existing.get(match.studentId);
      const prior = priorDoc ? workspaceFromDoc(priorDoc, match.studentId) : undefined;
      const workspace = mergeLiveChoiceRow(prior, row, settings, match.studentId, now);
      ops.push({ kind: 'workspace', cohortId: cohort.id, id: match.studentId, data: workspace });
    });
    const choiceKeys = new Set(settings.detectedChoiceKeys);
    if (text(settings.columnMappings.subjectChoice.primary)) choiceKeys.add(settings.primaryChoiceKey || 'choice1');
    if (text(settings.columnMappings.subjectChoice.secondary)) choiceKeys.add(settings.secondaryChoiceKey || 'choice2');
    if (text(settings.columnMappings.subjectChoice.interdisciplinary)) choiceKeys.add(settings.interdisciplinaryKey || 'interdisciplinary');
    const dynamicKeys = new Set(settings.detectedDynamicKeys);
    if (settings.hlColumn && text(settings.columnMappings.dashboard.hl)) dynamicKeys.add(settings.hlColumn);
    if (settings.supportColumn && text(settings.columnMappings.dashboard.support)) dynamicKeys.add(settings.supportColumn);
    const next = { ...mergeDetected(settings, [...choiceKeys].sort(), [...dynamicKeys].sort()), lastLiveSync: now };
    ops.push({ kind: 'config', cohortId: cohort.id, data: next });
    await app.store.applyAllocationOps(ops);
    return {
      cohortId: cohort.id,
      spreadsheetId: settings.spreadsheetId,
      sheetName: settings.sheetName || settings.liveSheetTab,
      incoming: parsed.rows.length,
      matched: seen.size,
      skipped,
      updated: seen.size,
      warnings: warnings.slice(0, WARNING_LIMIT),
    };
  });
}

async function workbookFor(app: App, deps?: LiveDeps): Promise<SheetWorkbook> {
  if (deps?.workbook) return deps.workbook;
  await requireDriveActor(app);
  return openGoogleWorkbook();
}

function spreadsheetIdOf(source: unknown): string {
  const value = source && typeof source === 'object' ? text((source as Doc).url || (source as Doc).spreadsheetId || (source as Doc).liveSheetUrl) : text(source);
  try {
    return spreadsheetIdFrom(value);
  } catch {
    throw new HubError('Enter a valid Google Sheet URL.');
  }
}

function sheetUrl(source: unknown, spreadsheetId: string): string {
  const value = source && typeof source === 'object' ? text((source as Doc).url || (source as Doc).liveSheetUrl) : text(source);
  if (/\/spreadsheets\/d\//.test(value)) return value;
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}
