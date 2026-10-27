// Collections the admin Sheets page may export or import. Add a row here to
// offer it on that page and to let the sheet functions read or write it.
// Anything absent — word-count samples, notification logs, function secrets —
// is rejected.

export type SheetCollectionGroup = 'records' | 'operational';

export interface CollectionRegistryEntry {
  id: string;
  /** Top-level Firestore collection for flat records. Rosters and message replies stay nested under their parent. */
  collectionId: string;
  displayName: string;
  sheet: string;
  group: SheetCollectionGroup;
  exportable: boolean;
  importable: boolean;
  recommended?: boolean;
  /** Header row for a collection that has no admin table schema. Schema-backed collections keep their own columns. */
  expectedColumns?: string[];
}

export interface SheetChoiceModel {
  id: string;
  label: string;
  sheet: string;
  group: SheetCollectionGroup;
  recommended: boolean;
  exportOnly: boolean;
  count: number;
}

export const COLLECTIONS_REGISTRY: CollectionRegistryEntry[] = [
  { id: 'phases', collectionId: 'phases', displayName: 'Phases', sheet: 'PHASES', group: 'records', exportable: true, importable: true, recommended: true, expectedColumns: ['phaseId'] },
  { id: 'milestoneTemplates', collectionId: 'milestoneTemplates', displayName: 'Milestones', sheet: 'MILESTONE_TEMPLATES', group: 'records', exportable: true, importable: true, recommended: true, expectedColumns: ['milestoneId'] },
  { id: 'cohorts', collectionId: 'cohorts', displayName: 'Cohorts', sheet: 'COHORTS', group: 'records', exportable: true, importable: true, recommended: true, expectedColumns: ['Cohort'] },
  { id: 'cohortMembers', collectionId: 'cohortMembers', displayName: 'Student lists', sheet: 'COHORT 2026', group: 'records', exportable: true, importable: true, recommended: true, expectedColumns: ['StudentId'] },
  { id: 'studentUsers', collectionId: 'studentUsers', displayName: 'Student users', sheet: 'USERS-STUDENTS', group: 'records', exportable: true, importable: true, recommended: true, expectedColumns: ['StudentId'] },
  { id: 'staffUsers', collectionId: 'staffUsers', displayName: 'Staff users', sheet: 'USERS-STAFF', group: 'records', exportable: true, importable: true, expectedColumns: ['EMAIL'] },
  { id: 'subjects', collectionId: 'subjects', displayName: 'Subjects', sheet: 'SUBJECTS', group: 'records', exportable: true, importable: true, expectedColumns: ['Subject ID'] },
  { id: 'resources', collectionId: 'resources', displayName: 'Resources', sheet: 'RESOURCES', group: 'records', exportable: true, importable: true, expectedColumns: ['Resource ID'] },
  { id: 'faqs', collectionId: 'faqs', displayName: 'FAQs', sheet: 'FAQS', group: 'records', exportable: true, importable: true, expectedColumns: ['FaqId'] },
  { id: 'ticketCategories', collectionId: 'ticketCategories', displayName: 'Message categories', sheet: 'TICKET_CATEGORIES', group: 'records', exportable: true, importable: true, expectedColumns: ['CategoryId'] },
  { id: 'quotations', collectionId: 'quotations', displayName: 'Quotations', sheet: 'Quotations', group: 'records', exportable: true, importable: true, expectedColumns: ['QuoteId'] },
  { id: 'studentActionItems', collectionId: 'studentActionItems', displayName: 'Student tasks', sheet: 'STUDENT_ACTION_ITEMS', group: 'operational', exportable: true, importable: true, expectedColumns: ['TaskId'] },
  { id: 'formDefinitions', collectionId: 'formDefinitions', displayName: 'Milestone forms', sheet: 'FORM_DEFINITIONS', group: 'operational', exportable: true, importable: true, expectedColumns: ['milestoneId'] },
  { id: 'formResponses', collectionId: 'formResponses', displayName: 'Form answers', sheet: 'FORM milestoneId', group: 'operational', exportable: true, importable: true, expectedColumns: ['StudentId'] },
  { id: 'milestoneEvents', collectionId: 'milestoneEvents', displayName: 'Milestone notes', sheet: 'MILESTONE_EVENTS', group: 'operational', exportable: true, importable: true, expectedColumns: ['EventId'] },
  { id: 'tickets', collectionId: 'tickets', displayName: 'Messages', sheet: 'TICKETS', group: 'operational', exportable: true, importable: true, expectedColumns: ['TicketId'] },
  { id: 'ticketMessages', collectionId: 'ticketMessages', displayName: 'Message replies', sheet: 'TICKET_MESSAGES', group: 'operational', exportable: true, importable: true, expectedColumns: ['MessageId'] },
  { id: 'todoTemplates', collectionId: 'todoTemplates', displayName: 'Template tasks', sheet: 'TODO_TEMPLATES', group: 'operational', exportable: true, importable: true, expectedColumns: ['TemplateId'] },
  { id: 'supervisorTodos', collectionId: 'supervisorTodos', displayName: 'Supervisor to-dos', sheet: 'SUPERVISOR_TODOS', group: 'operational', exportable: true, importable: true, expectedColumns: ['TodoId'] },
  { id: 'auditLogs', collectionId: 'auditLogs', displayName: 'Audit log', sheet: 'AUDIT_LOGS', group: 'operational', exportable: true, importable: false, expectedColumns: ['Timestamp', 'User', 'Action'] },
];

export function registeredSheetCollection(id: string): CollectionRegistryEntry | undefined {
  const entry = COLLECTIONS_REGISTRY.find((item) => item.id === id);
  if (!entry || (!entry.exportable && !entry.importable)) return undefined;
  return entry;
}

/** Null when the action is allowed. Otherwise the rejection the sheet functions throw. */
export function sheetCollectionRejection(id: string, action: 'export' | 'import'): string | null {
  const entry = registeredSheetCollection(id);
  if (!entry) return `Collection "${id}" is not registered for sheet import or export.`;
  if (action === 'export' && !entry.exportable) return `Collection "${id}" is not registered for sheet export.`;
  if (action === 'import' && !entry.importable) {
    if (entry.id === 'auditLogs') return 'Audit logs can be exported, but they are not replaced from a sheet.';
    return `Collection "${id}" is not registered for sheet import.`;
  }
  return null;
}

/** Choices the Sheets page can show. Counts come from the server when it has them. */
export function sheetChoiceModels(counts: Record<string, number> = {}): SheetChoiceModel[] {
  return COLLECTIONS_REGISTRY.filter((entry) => entry.exportable || entry.importable).map((entry) => ({
    id: entry.id,
    label: entry.displayName,
    sheet: entry.sheet,
    group: entry.group,
    recommended: !!entry.recommended,
    exportOnly: entry.exportable && !entry.importable,
    count: counts[entry.id] || 0,
  }));
}
