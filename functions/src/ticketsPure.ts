import { normalizeEmail, text, toBoolean } from './util';
import type { HubUser } from './permissions';

export interface TicketShape {
  ticketId?: string;
  studentId: string;
  category: string;
  title?: string;
  status?: string;
  route: string;
  assignee: string;
  shared: boolean;
  studentUnread?: boolean;
  staffUnread?: boolean;
  lastUpdated?: string;
  createdAt?: string;
  lastActor?: string;
  cohort?: string;
}

export function ticketIsShared(record: Record<string, any>): boolean {
  const value = record.Shared;
  if (value === '' || value === null || typeof value === 'undefined') return true;
  return toBoolean(value);
}

export function ticketFromRecord(record: Record<string, any>): TicketShape {
  return {
    ticketId: text(record.TicketId),
    studentId: normalizeEmail(record.StudentId),
    cohort: text(record.Cohort),
    category: text(record.Category),
    title: text(record.Title),
    status: text(record.Status),
    route: text(record.Route),
    assignee: normalizeEmail(record.Assignee),
    createdAt: text(record.CreatedAt),
    lastUpdated: text(record.LastUpdated),
    lastActor: normalizeEmail(record.LastActor),
    studentUnread: toBoolean(record.StudentUnread),
    staffUnread: toBoolean(record.StaffUnread),
    shared: ticketIsShared(record),
  };
}

export function ticketAuthorEmail(ticket: TicketShape): string {
  if (text(ticket.category) === 'Note') return normalizeEmail(ticket.assignee);
  return normalizeEmail(ticket.studentId);
}

export function studentCanSeeTicket(email: string, ticket: TicketShape): boolean {
  const wanted = normalizeEmail(email);
  if (ticket.studentId !== wanted) return false;
  if (ticket.shared) return true;
  return text(ticket.category) !== 'Note' && ticketAuthorEmail(ticket) === wanted;
}

export function staffCanSeeTicket(
  user: HubUser,
  view: string,
  ticket: TicketShape,
  placement?: { supervisorId?: string } | null,
): boolean {
  if (!ticket.shared) return false;
  if (view === 'coordinator') {
    if (!user.permissions?.canAdmin) return false;
    if (ticket.route === 'coordinator') return true;
    return ticket.route === 'supervisor' && !ticket.assignee;
  }
  if (view === 'supervisor') {
    if (!user.permissions?.isSupervisor) return false;
    if (ticket.route !== 'supervisor') return false;
    if (ticket.assignee && ticket.assignee === user.email) return true;
    return !!(placement && normalizeEmail(placement.supervisorId) === user.email);
  }
  return false;
}

export function assigneeForRoute(route: string, placement?: { supervisorId?: string } | null): string {
  if (route === 'supervisor' && placement) return normalizeEmail(placement.supervisorId);
  return '';
}

export function routeLabel(ticket: TicketShape): string {
  if (ticket.route === 'coordinator') return 'EE Coordinator';
  if (!ticket.assignee) return 'Supervisor · unassigned';
  return 'Supervisor';
}

const TICKET_CATEGORY_CHIPS = ['c-sm', 'c-cit', 'c-eth', 'c-ext', 'c-tech'];

export function ticketChip(name: string): string {
  const known: Record<string, string> = {
    'Subject & Methodology': 'c-sm',
    Citations: 'c-cit',
    Ethics: 'c-eth',
    Extensions: 'c-ext',
    Technical: 'c-tech',
  };
  if (known[name]) return known[name];
  let hash = 0;
  const source = String(name || '');
  for (let index = 0; index < source.length; index++) hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  return TICKET_CATEGORY_CHIPS[Math.abs(hash) % TICKET_CATEGORY_CHIPS.length];
}

export const DEFAULT_TICKET_CATEGORIES = [
  { id: 'cat-subject', name: 'Subject & Methodology', route: 'supervisor', sort: 1 },
  { id: 'cat-citations', name: 'Citations', route: 'supervisor', sort: 2 },
  { id: 'cat-ethics', name: 'Ethics', route: 'coordinator', sort: 3 },
  { id: 'cat-extensions', name: 'Extensions', route: 'coordinator', sort: 4 },
  { id: 'cat-technical', name: 'Technical', route: 'coordinator', sort: 5 },
];
