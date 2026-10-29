// Export hub collections to a Google Sheet, and replace those collections from
// a sheet the admin has edited. The connected Google account creates and reads
// the spreadsheet. Tabs use the same names as the workbook import.

import { presentDriveAccount, requireDriveActor } from './driveAccount';
import { getGoogleAuth } from './googleAuth';
import { assertSafeResourceHtml } from './formsPure';
import { validatePhasePrerequisites } from './phaseRules';
import { assertSingleMilestoneAnchor } from './pathwayPlan';
import { APP_TABLES, COLLECTIONS, normalizePhaseColor, staffHasAdminAccess, tableFields, validateRecordFields } from './schema';
import { App, audited, requireAdmin } from './session';
import { formatSubjectCell, preserveEeActive } from './allocationPure';
import { CollectionRegistryEntry, registeredSheetCollection, sheetChoiceModels } from './collectionsRegistry';
import { guardSheetCollection, planSheetImport, SheetGrid, SheetImportPlan, spreadsheetIdFrom } from './sheetImport';
import { keepPublishedSubject, presentStoredIdentifiers, syncStudentUserFromMember } from './studentIdentity';
import { dateOnlyValue, Doc, driveNamePart, HubError, normalizeEmail, text, toBoolean } from './util';

const ROW_LIMIT = 5000;
const CONFIRM_REPLACE = 'Confirm that rows missing from the selected tabs will be removed from the hub.';

export interface SheetCollectionChoice {
  id: string;
  label: string;
  sheet: string;
  group: 'records' | 'operational';
  recommended: boolean;
  exportOnly: boolean;
  count: number;
}

export interface SheetWorkbookFile {
  spreadsheetId: string;
  url: string;
}

export interface SheetWorkbook {
  create(title: string, grids: SheetGrid[]): Promise<SheetWorkbookFile>;
  read(spreadsheetId: string): Promise<SheetGrid[]>;
  share(spreadsheetId: string, email: string): Promise<void>;
  /** Tab titles only. Callers fall back to read() when a workbook does not implement this. */
  listTabs?(spreadsheetId: string): Promise<string[]>;
  /** One tab, including its header row. Callers fall back to read() when this is omitted. */
  readTab?(spreadsheetId: string, title: string): Promise<SheetGrid>;
}

export interface IngestTable {
  id: string;
  label: string;
  sheet: string;
  incoming: number;
  existing: number;
  removing: number;
}

export interface IngestPreview {
  spreadsheetId: string;
  tables: IngestTable[];
  warnings: string[];
  warningCount: number;
}

interface SheetCatalogItem extends CollectionRegistryEntry {
  label: string;
  exportOnly: boolean;
}

const FORM_HEADERS = ['StudentId', 'FormVersion', 'Status', 'SubmittedAt', 'LastUpdated'];

export function sheetTabTitle(title: string): string {
  return title.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function listSheetCollections(app: App): Promise<{ collections: SheetCollectionChoice[]; driveActor: string; driveReady: boolean }> {
  await requireAdmin(app, 'LIST_SHEET_COLLECTIONS');
  const account = await presentDriveAccount(app);
  const collections = await Promise.all(sheetChoiceModels().map(async (item) => ({
    ...item,
    count: await collectionCount(app, item.id),
  })));
  return { collections, driveActor: account.actorEmail, driveReady: account.ready };
}

export async function exportSheetCollections(
  app: App,
  entities: unknown,
  deps?: { workbook?: SheetWorkbook; actorEmail?: string; now?: Date },
): Promise<SheetWorkbookFile & { shared: boolean; shareProblem: string; owner: string; title: string }> {
  const user = await requireAdmin(app, 'EXPORT_SHEET_COLLECTIONS');
  const selected = selectedEntities(entities);
  const grids = await buildExportGrids(app, selected);
  return audited(app, user, 'EXPORT_SHEET_COLLECTIONS', { entities: selected }, async () => {
    const owner = deps?.workbook ? normalizeEmail(deps.actorEmail) || user.email : (await requireDriveActor(app)).actorEmail;
    const workbook = deps?.workbook || await googleWorkbook();
    const title = `EE Hub export ${(deps?.now || new Date()).toISOString().slice(0, 10)}`;
    const created = await workbook.create(title, grids);
    let shared = normalizeEmail(owner) === user.email;
    let shareProblem = '';
    if (!shared) {
      try {
        await workbook.share(created.spreadsheetId, user.email);
        shared = true;
      } catch (error) {
        shareProblem = error instanceof Error ? error.message : 'The spreadsheet could not be shared.';
      }
    }
    return { ...created, shared, shareProblem, owner, title };
  });
}

export async function previewSheetIngest(app: App, source: unknown, entities: unknown, deps?: { workbook?: SheetWorkbook }): Promise<IngestPreview> {
  await requireAdmin(app, 'PREVIEW_SHEET_INGEST');
  const selected = selectedEntities(entities, true);
  const loaded = await loadIngest(app, source, selected, deps);
  return loaded.preview;
}

export async function applySheetIngest(
  app: App,
  source: unknown,
  entities: unknown,
  confirmReplace: unknown,
  deps?: { workbook?: SheetWorkbook },
): Promise<IngestPreview> {
  const user = await requireAdmin(app, 'APPLY_SHEET_INGEST');
  const selected = selectedEntities(entities, true);
  if (confirmReplace !== true) throw new HubError(CONFIRM_REPLACE);
  const loaded = await loadIngest(app, source, selected, deps);
  return audited(app, user, 'APPLY_SHEET_INGEST', {
    entities: selected,
    spreadsheetId: loaded.preview.spreadsheetId,
    removing: loaded.preview.tables.reduce((sum, table) => sum + table.removing, 0),
  }, async () => {
    await writeIngest(app, loaded.plan, selected, loaded.cohortIds, loaded.formIds);
    return loaded.preview;
  });
}

export async function buildExportGrids(app: App, entities: string[]): Promise<SheetGrid[]> {
  const grids: SheetGrid[] = [];
  for (const id of entities) {
    guardSheetCollection(id, 'export');
    if (id === 'cohortMembers') {
      const cohorts = (await app.store.list(COLLECTIONS.cohorts))
        .map((row) => text(row.Cohort))
        .filter((cohortId) => /^\d{4}$/.test(cohortId))
        .sort();
      const fields = tableFields('cohortMembers').map((field) => field.name);
      for (const cohortId of cohorts) {
        const members = sortBy(await app.store.listMembers(cohortId), 'Surname', 'StudentId').map((member) => presentStoredIdentifiers(member));
        grids.push(gridFor('cohortMembers', sheetTabTitle(`COHORT: ${cohortId}`), fields, members));
      }
      if (!cohorts.length) grids.push(gridFor('cohortMembers', 'COHORT 2026', fields, []));
      continue;
    }
    if (id === 'formResponses') {
      const responses = await app.store.list(COLLECTIONS.formResponses);
      const byMilestone = new Map<string, Doc[]>();
      responses.forEach((row) => {
        const milestoneId = text(row.MilestoneId);
        if (!milestoneId) return;
        const group = byMilestone.get(milestoneId) || [];
        group.push(row);
        byMilestone.set(milestoneId, group);
      });
      const milestones = [...byMilestone.keys()].sort();
      for (const milestoneId of milestones) {
        const rows = byMilestone.get(milestoneId) || [];
        const extra = new Set<string>();
        rows.forEach((row) => Object.keys(row).forEach((key) => {
          if (!FORM_HEADERS.includes(key) && key !== 'MilestoneId') extra.add(key);
        }));
        const fields = FORM_HEADERS.concat([...extra].sort());
        grids.push({
          title: sheetTabTitle(`FORM: ${milestoneId}`),
          rows: [fields, ...sortBy(rows, 'StudentId').map((row) => fields.map((name) => plainCell(row[name])))],
        });
      }
      continue;
    }
    if (!APP_TABLES[id]) {
      const item = catalogItem(id);
      const columns = item.expectedColumns || [];
      if (!columns.length) throw new HubError(`Collection "${id}" needs expectedColumns in the sheet registry.`);
      const records = sortBy(await app.store.list(item.collectionId), columns[0]);
      grids.push({
        title: item.sheet,
        rows: [columns, ...records.map((record) => columns.map((name) => plainCell(record[name])))],
      });
      continue;
    }
    const item = catalogItem(id);
    const fields = tableFields(id).map((field) => field.name);
    let records = sortRecords(id, id === 'ticketMessages' ? await allMessages(app) : await app.store.list(item.collectionId));
    if (id === 'studentUsers') records = records.map((record) => presentStoredIdentifiers(record));
    grids.push(gridFor(id, item.sheet, fields, records));
  }
  grids.forEach((grid) => {
    if (grid.rows.length - 1 > ROW_LIMIT) throw new HubError(`${grid.title} has too many rows to export in one sheet.`);
  });
  return grids;
}

function gridFor(entity: string, title: string, fields: string[], records: Doc[]): SheetGrid {
  const defs = new Map(tableFields(entity).map((field) => [field.name, field]));
  return {
    title,
    rows: [fields, ...records.map((record) => fields.map((name) => exportCell(defs.get(name), name, record[name])))],
  };
}

function exportCell(field: { name: string; type: string } | undefined, name: string, value: unknown): string | number | boolean {
  if (name === 'FolderPrefix' || name === 'FolderSuffix') return driveNamePart(value);
  if (value === undefined || value === null || value === '') return '';
  if (field?.type === 'checks') return formatSubjectCell(value);
  if (field?.type === 'checkbox') return toBoolean(value);
  if (field?.type === 'number') {
    const numeric = typeof value === 'number' ? value : Number(text(value));
    return Number.isFinite(numeric) ? numeric : '';
  }
  if (field?.type === 'date') return dateOnlyValue(value);
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  return text(value);
}

function plainCell(value: unknown): string | number | boolean {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  return text(value);
}

async function loadIngest(app: App, source: unknown, entities: string[], deps?: { workbook?: SheetWorkbook }): Promise<{
  preview: IngestPreview;
  plan: SheetImportPlan;
  cohortIds: string[];
  formIds: string[];
}> {
  const spreadsheetId = readSpreadsheetId(source);
  if (!deps?.workbook) await requireDriveActor(app);
  const workbook = deps?.workbook || await googleWorkbook();
  const grids = await workbook.read(spreadsheetId);
  const plan = planSheetImport(grids);
  const cohortIds = cohortTabs(grids);
  const formIds = formTabs(grids);
  assertTabsPresent(entities, grids, cohortIds, formIds);
  await validateIngest(app, plan, entities, cohortIds);
  const tables = await Promise.all(entities.map((id) => previewTable(app, plan, id, cohortIds, formIds)));
  return {
    plan,
    cohortIds,
    formIds,
    preview: { spreadsheetId, tables, warnings: plan.warnings, warningCount: plan.warningCount },
  };
}

async function previewTable(app: App, plan: SheetImportPlan, id: string, cohortIds: string[], formIds: string[]): Promise<IngestTable> {
  const item = catalogItem(id);
  if (id === 'cohortMembers') {
    let existing = 0;
    let removing = 0;
    let incoming = 0;
    for (const cohortId of cohortIds) {
      const current = await app.store.listMembers(cohortId);
      const keep = new Set(plan.members.filter((member) => member.cohortId === cohortId).map((member) => member.id));
      existing += current.length;
      incoming += keep.size;
      removing += current.filter((member) => !keep.has(normalizeEmail(member.StudentId))).length;
    }
    return { id, label: item.label, sheet: item.sheet, incoming, existing, removing };
  }
  if (id === 'ticketMessages') {
    const tickets = await app.store.list(COLLECTIONS.tickets);
    const keep = new Set(plan.messages.map((message) => `${message.ticketId}\u0000${message.id}`));
    let existing = 0;
    let removing = 0;
    for (const ticket of tickets) {
      const ticketId = text(ticket.TicketId);
      const messages = await app.store.listMessages(ticketId);
      existing += messages.length;
      removing += messages.filter((message) => !keep.has(`${ticketId}\u0000${text(message.MessageId)}`)).length;
    }
    return { id, label: item.label, sheet: item.sheet, incoming: plan.messages.length, existing, removing };
  }
  if (id === 'formResponses') {
    const existingRows = (await app.store.list(COLLECTIONS.formResponses)).filter((row) => formIds.includes(text(row.MilestoneId)));
    const incoming = (plan.docs[COLLECTIONS.formResponses] || []).filter((doc) => formIds.includes(text(doc.data.MilestoneId)));
    const keep = new Set(incoming.map((doc) => doc.id));
    const removing = existingRows.filter((row) => !keep.has(`${text(row.MilestoneId)}__${encodeURIComponent(normalizeEmail(row.StudentId))}`)).length;
    return { id, label: item.label, sheet: item.sheet, incoming: incoming.length, existing: existingRows.length, removing };
  }
  const collection = item.collectionId;
  const existingRows = await app.store.list(collection);
  const incoming = plan.docs[collection] || [];
  const keep = new Set(incoming.map((doc) => doc.id));
  const removing = existingRows.filter((row) => {
    const existingId = rowId(id, row);
    return existingId && !keep.has(existingId);
  }).length;
  return { id, label: item.label, sheet: item.sheet, incoming: incoming.length, existing: existingRows.length, removing };
}

async function validateIngest(app: App, plan: SheetImportPlan, entities: string[], cohortIds: string[]): Promise<void> {
  for (const id of entities) {
    if (id === 'cohortMembers') {
      for (const member of plan.members.filter((row) => cohortIds.includes(row.cohortId))) {
        checkRow('Student lists', member.id, 'cohortMembers', member.data);
      }
      continue;
    }
    if (id === 'ticketMessages') {
      const ticketIds = new Set(entities.includes('tickets')
        ? (plan.docs[COLLECTIONS.tickets] || []).map((doc) => doc.id)
        : (await app.store.list(COLLECTIONS.tickets)).map((row) => text(row.TicketId)));
      plan.messages.forEach((message) => {
        checkRow('Message replies', message.id, 'ticketMessages', message.data);
        if (!ticketIds.has(message.ticketId)) throw new HubError(`Message replies row ${message.id} refers to a message thread that is not in the hub.`);
      });
      continue;
    }
    if (id === 'formResponses') continue;
    const item = catalogItem(id);
    if (!APP_TABLES[id]) {
      const key = item.expectedColumns?.[0] || '';
      const docs = plan.docs[item.collectionId] || [];
      if (!key) throw new HubError(`Collection "${id}" needs expectedColumns in the sheet registry.`);
      docs.forEach((doc) => {
        const nextId = text(doc.data[key]);
        if (!nextId) throw new HubError(`${item.label} row is missing ${key}.`);
        doc.id = nextId;
      });
      continue;
    }
    const docs = plan.docs[item.collectionId] || [];
    docs.forEach((doc) => {
      doc.data = normalizeIncoming(id, doc.data);
      const nextId = rowId(id, doc.data);
      if (nextId) doc.id = nextId;
      checkRow(item.label, doc.id, id, doc.data);
    });
    if (id === 'phases') {
      const links = docs.map((doc) => ({ phaseId: text(doc.data.phaseId), prerequisitePhaseId: text(doc.data.prerequisitePhaseId) }));
      links.forEach((link) => validatePhasePrerequisites(links, link.phaseId, link.prerequisitePhaseId));
    }
    if (id === 'milestoneTemplates') {
      const active = await activePhaseIds(app, entities, plan);
      docs.forEach((doc) => {
        if (!active.has(text(doc.data.phase))) throw new HubError(`Milestones row ${doc.id} needs an active phase.`);
      });
      assertSingleMilestoneAnchor(docs.map((doc) => doc.data));
    }
    if (id === 'staffUsers') {
      docs.forEach((doc) => { doc.data.isStaff = true; });
      if (!docs.some((doc) => staffHasAdminAccess(doc.data))) throw new HubError('Keep at least one admin or coordinator in the staff sheet.');
    }
    if (id === 'resources') {
      docs.forEach((doc) => {
        if (text(doc.data.Body).length > 40000) throw new HubError(`Resources row ${doc.id} has a body over 40,000 characters.`);
        doc.data['Body Format'] = text(doc.data['Body Format']).toLowerCase() || 'plain';
        if (doc.data['Body Format'] === 'html') assertSafeResourceHtml(text(doc.data.Body));
      });
    }
    if (id === 'ticketCategories') {
      const names = new Set<string>();
      docs.forEach((doc) => {
        const name = text(doc.data.Name).toLowerCase();
        if (names.has(name)) throw new HubError(`Message categories has more than one row named ${doc.data.Name}.`);
        names.add(name);
      });
    }
  }
}

async function activePhaseIds(app: App, entities: string[], plan: SheetImportPlan): Promise<Set<string>> {
  const rows = entities.includes('phases')
    ? (plan.docs[COLLECTIONS.phases] || []).map((doc) => doc.data)
    : await app.store.list(COLLECTIONS.phases);
  return new Set(rows.filter((row) => toBoolean(row.active)).map((row) => text(row.phaseId).toLowerCase()));
}

function normalizeIncoming(entity: string, data: Doc): Doc {
  const copy = { ...data };
  if (entity === 'milestoneTemplates') {
    copy.type = text(copy.type).toLowerCase();
    copy.mOwner = text(copy.mOwner).toLowerCase();
  }
  if (entity === 'phases') {
    copy.phaseId = text(copy.phaseId).toLowerCase();
    copy.sequence = copy.sequence === '' || copy.sequence === undefined ? copy.sequence : Number(copy.sequence);
    copy.active = copy.active === '' || copy.active === undefined ? true : toBoolean(copy.active);
    if (text(copy.phaseColor)) {
      const colour = normalizePhaseColor(copy.phaseColor);
      if (colour) copy.phaseColor = colour;
    }
  }
  if (entity === 'staffUsers') {
    ['isSupervisor', 'isLead', 'isCoordinator', 'isAdmin'].forEach((name) => {
      if (copy[name] !== '' && copy[name] !== undefined) copy[name] = toBoolean(copy[name]);
    });
  }
  return copy;
}

function checkRow(label: string, id: string, entity: string, data: Doc): void {
  try {
    validateRecordFields(entity, data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'This row could not be read.';
    throw new HubError(`${label} row ${id}: ${message}`);
  }
}

async function keepCohortPlan(app: App, cohortId: string, data: Doc): Promise<Doc> {
  const existing = await app.store.get(COLLECTIONS.cohorts, cohortId);
  if (!existing) return data;
  const next = { ...data };
  if (text(existing.PlanAnchor) && !text(next.PlanAnchor)) next.PlanAnchor = text(existing.PlanAnchor);
  if (existing.PathwaySeeded !== undefined && next.PathwaySeeded === undefined) next.PathwaySeeded = toBoolean(existing.PathwaySeeded);
  return next;
}

async function writeIngest(app: App, plan: SheetImportPlan, entities: string[], cohortIds: string[], formIds: string[]): Promise<void> {
  const order = sheetChoiceModels().map((item) => item.id);
  const sorted = entities.slice().sort((left, right) => order.indexOf(left) - order.indexOf(right));
  for (const id of sorted) {
    if (id === 'cohortMembers') {
      for (const cohortId of cohortIds) {
        if (!(await app.store.get(COLLECTIONS.cohorts, cohortId))) {
          await app.store.set(COLLECTIONS.cohorts, cohortId, {
            Cohort: cohortId,
            SheetName: `COHORT: ${cohortId}`,
            Status: 'Active',
            DriveRootFolderId: '',
            FolderPrefix: '',
            FolderSuffix: '',
            EEDocTemplateId: '',
          });
        }
        const priorRows = await app.store.listMembers(cohortId);
        const prior = new Map(priorRows.map((member) => [normalizeEmail(member.StudentId), member]));
        const incoming = plan.members.filter((member) => member.cohortId === cohortId);
        const keep = new Set(incoming.map((member) => member.id));
        for (const member of incoming) {
          const previous = prior.get(member.id);
          const stored = keepPublishedSubject(preserveEeActive(member.data, previous), previous);
          await app.store.setMember(cohortId, member.id, stored);
          await syncStudentUserFromMember(app.store, stored);
        }
        for (const existing of await app.store.listMembers(cohortId)) {
          const memberId = normalizeEmail(existing.StudentId);
          if (memberId && !keep.has(memberId)) await app.store.removeMember(cohortId, memberId);
        }
      }
      continue;
    }
    if (id === 'ticketMessages') {
      for (const message of plan.messages) await app.store.addMessage(message.ticketId, message.id, message.data);
      const keep = new Set(plan.messages.map((message) => `${message.ticketId}\u0000${message.id}`));
      for (const ticket of await app.store.list(COLLECTIONS.tickets)) {
        const ticketId = text(ticket.TicketId);
        for (const message of await app.store.listMessages(ticketId)) {
          const messageId = text(message.MessageId);
          if (!keep.has(`${ticketId}\u0000${messageId}`)) await app.store.removeMessage(ticketId, messageId);
        }
      }
      continue;
    }
    if (id === 'formResponses') {
      const incoming = (plan.docs[COLLECTIONS.formResponses] || []).filter((doc) => formIds.includes(text(doc.data.MilestoneId)));
      const keep = new Set(incoming.map((doc) => doc.id));
      for (const doc of incoming) await app.store.set(COLLECTIONS.formResponses, doc.id, doc.data);
      for (const existing of await app.store.list(COLLECTIONS.formResponses)) {
        if (!formIds.includes(text(existing.MilestoneId))) continue;
        const idForRow = `${text(existing.MilestoneId)}__${encodeURIComponent(normalizeEmail(existing.StudentId))}`;
        if (!keep.has(idForRow)) await app.store.remove(COLLECTIONS.formResponses, idForRow);
      }
      continue;
    }
    const collection = catalogItem(id).collectionId;
    const incoming = plan.docs[collection] || [];
    const keep = new Set(incoming.map((doc) => doc.id));
    for (const doc of incoming) {
      const data = id === 'cohorts'
        ? await keepCohortPlan(app, doc.id, doc.data)
        : id === 'studentUsers'
          ? keepPublishedSubject(doc.data, await app.store.get(collection, doc.id))
          : doc.data;
      await app.store.set(collection, doc.id, data);
    }
    for (const existing of await app.store.list(collection)) {
      const existingId = rowId(id, existing);
      if (!existingId || keep.has(existingId)) continue;
      if (id === 'tickets') {
        for (const message of await app.store.listMessages(existingId)) {
          await app.store.removeMessage(existingId, text(message.MessageId));
        }
      }
      await app.store.remove(collection, existingId);
    }
  }
}

function assertTabsPresent(entities: string[], grids: SheetGrid[], cohortIds: string[], formIds: string[]): void {
  entities.forEach((id) => {
    if (id === 'cohortMembers') {
      if (!cohortIds.length) throw new HubError('The spreadsheet has no COHORT 2026 tab. A missing tab is left unchanged.');
      return;
    }
    if (id === 'formResponses') {
      if (!formIds.length) throw new HubError('The spreadsheet has no FORM tab. A missing tab is left unchanged.');
      return;
    }
    const item = catalogItem(id);
    const found = grids.some((grid) => grid.title.trim().toLowerCase() === item.sheet.toLowerCase());
    if (!found) throw new HubError(`The spreadsheet has no ${item.sheet} tab. A missing tab is left unchanged.`);
  });
}

export function cohortTabs(grids: SheetGrid[]): string[] {
  const ids: string[] = [];
  grids.forEach((grid) => {
    const match = /^(?:cohort:\s*|cohort\s+)(\d{4})$/i.exec(grid.title.trim());
    if (match && !ids.includes(match[1])) ids.push(match[1]);
  });
  return ids;
}

export function formTabs(grids: SheetGrid[]): string[] {
  const ids: string[] = [];
  grids.forEach((grid) => {
    const match = /^(?:form:\s*|form\s+)([a-z][a-z0-9_-]*)$/i.exec(grid.title.trim());
    const id = match ? match[1].toLowerCase() : '';
    if (id && !ids.includes(id)) ids.push(id);
  });
  return ids;
}

function selectedEntities(value: unknown, ingest = false): string[] {
  if (!Array.isArray(value) || !value.length) throw new HubError('Choose at least one collection.');
  const ids: string[] = [];
  value.forEach((item) => {
    const id = text(item);
    guardSheetCollection(id, ingest ? 'import' : 'export');
    if (!ids.includes(id)) ids.push(id);
  });
  return ids;
}

function rowId(entity: string, data: Doc): string {
  if (!APP_TABLES[entity]) {
    const key = catalogItem(entity).expectedColumns?.[0] || '';
    return text(data[key]);
  }
  const key = tableFields(entity).find((field) => field.key);
  if (!key) return '';
  let value = text(data[key.name]);
  if (!value) return '';
  if (entity === 'phases') value = value.toLowerCase();
  if (key.type === 'email' || key.validator === 'email' || key.name.toLowerCase().includes('email')) value = normalizeEmail(value);
  return value;
}

function catalogItem(id: string): SheetCatalogItem {
  const entry = registeredSheetCollection(id);
  if (!entry) throw new HubError(`Collection "${id}" is not registered for sheet import or export.`);
  return { ...entry, label: entry.displayName, exportOnly: entry.exportable && !entry.importable };
}

function readSpreadsheetId(source: unknown): string {
  const value = source && typeof source === 'object' ? text((source as Doc).spreadsheetId || (source as Doc).url) : text(source);
  try {
    return spreadsheetIdFrom(value);
  } catch {
    throw new HubError('Paste a Google Sheet link.');
  }
}

async function allMessages(app: App): Promise<Doc[]> {
  const tickets = await app.store.list(COLLECTIONS.tickets);
  const groups = await Promise.all(tickets.map((ticket) => app.store.listMessages(text(ticket.TicketId))));
  return groups.flat();
}

async function collectionCount(app: App, id: string): Promise<number> {
  if (id === 'cohortMembers') return (await app.store.allMembers()).length;
  if (id === 'ticketMessages') return (await allMessages(app)).length;
  return (await app.store.list(catalogItem(id).collectionId)).length;
}

function sortRecords(entity: string, records: Doc[]): Doc[] {
  if (entity === 'phases') return records.slice().sort((left, right) => Number(left.sequence) - Number(right.sequence) || text(left.phaseId).localeCompare(text(right.phaseId)));
  if (entity === 'milestoneTemplates') return records.slice().sort((left, right) => Number(left.position || 0) - Number(right.position || 0) || text(left.milestoneId).localeCompare(text(right.milestoneId)));
  if (entity === 'auditLogs') return records.slice().sort((left, right) => text(left.Timestamp).localeCompare(text(right.Timestamp)));
  const key = tableFields(entity).find((field) => field.key)?.name || '';
  return sortBy(records, key);
}

function sortBy(records: Doc[], ...fields: string[]): Doc[] {
  return records.slice().sort((left, right) => {
    for (const field of fields) {
      const compared = text(left[field]).localeCompare(text(right[field]));
      if (compared) return compared;
    }
    return 0;
  });
}

export function openGoogleWorkbook(): Promise<SheetWorkbook> {
  return googleWorkbook();
}

export async function listWorkbookTabs(workbook: SheetWorkbook, spreadsheetId: string): Promise<string[]> {
  if (workbook.listTabs) {
    const titles = await workbook.listTabs(spreadsheetId);
    return titles.map((title) => text(title)).filter(Boolean);
  }
  const grids = await workbook.read(spreadsheetId);
  return grids.map((grid) => text(grid.title)).filter(Boolean);
}

export async function readWorkbookTab(workbook: SheetWorkbook, spreadsheetId: string, title: string): Promise<SheetGrid> {
  const wanted = text(title);
  if (!wanted) throw new HubError('Choose a sheet tab.');
  if (workbook.readTab) {
    const tabs = await listWorkbookTabs(workbook, spreadsheetId);
    if (!tabs.includes(wanted)) throw new HubError(`The spreadsheet has no tab named "${wanted}".`);
    return workbook.readTab(spreadsheetId, wanted);
  }
  const grids = await workbook.read(spreadsheetId);
  const grid = grids.find((item) => item.title === wanted);
  if (!grid) throw new HubError(`The spreadsheet has no tab named "${wanted}".`);
  return grid;
}

async function googleWorkbook(): Promise<SheetWorkbook> {
  const auth = await getGoogleAuth();
  const { google } = await import('googleapis');
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });
  return {
    async create(title, grids) {
      const created = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title },
          sheets: grids.map((grid, index) => ({ properties: { title: grid.title, index } })),
        },
        fields: 'spreadsheetId,sheets.properties',
      });
      const spreadsheetId = created.data.spreadsheetId || '';
      if (!spreadsheetId) throw new HubError('The spreadsheet could not be created.');
      const extras = (created.data.sheets || [])
        .map((sheet) => sheet.properties)
        .filter((properties) => properties && !grids.some((grid) => grid.title === properties?.title));
      if (extras.length && (created.data.sheets || []).length > extras.length) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: extras.map((properties) => ({ deleteSheet: { sheetId: properties?.sheetId } })),
          },
        });
      }
      if (grids.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: grids.map((grid) => ({
              range: `'${grid.title.replace(/'/g, "''")}'!A1`,
              values: grid.rows as never,
            })),
          },
        });
      }
      return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
    },
    async listTabs(spreadsheetId) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      return (meta.data.sheets || []).map((sheet) => sheet.properties?.title || '').filter(Boolean);
    },
    async readTab(spreadsheetId, title) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${title.replace(/'/g, "''")}'`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });
      return { title, rows: response.data.values || [] };
    },
    async read(spreadsheetId) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      const titles = (meta.data.sheets || []).map((sheet) => sheet.properties?.title || '').filter(Boolean);
      const loaded: SheetGrid[] = [];
      for (const title of titles) {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `'${title.replace(/'/g, "''")}'`,
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER',
        });
        loaded.push({ title, rows: response.data.values || [] });
      }
      return loaded;
    },
    async share(spreadsheetId, email) {
      await drive.permissions.create({
        fileId: spreadsheetId,
        sendNotificationEmail: false,
        supportsAllDrives: true,
        requestBody: { type: 'user', role: 'writer', emailAddress: email },
      });
    },
  };
}
