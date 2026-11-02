import { listTodoTemplatesFor } from './actions';
import { HubUser, normalizeStaffView } from './permissions';
import { findPlacement, readPhases, readRoster, readStaffTables, staffMayAddStudentTodo, staffMayViewPlacement, staffStudentContext, StaffTables } from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, deny, requireStaff, requireUser } from './session';
import { compareRecentActivity, isStaffNote, routeLabel, staffCanSeeTicket, staffNotesForRoster, staffNotesForStudent, studentCanSeeTicket, ticketAuthorEmail, ticketFromRecord, TicketShape } from './ticketsPure';
import { Doc, HubError, normalizeEmail, nowIso, text, textHash, toBoolean, uuid } from './util';

export async function readAllTickets(app: App): Promise<TicketShape[]> {
  const records = await app.store.list(COLLECTIONS.tickets);
  return records.map(ticketFromRecord);
}

async function loadTicket(app: App, ticketId: string) {
  return app.store.get(COLLECTIONS.tickets, text(ticketId));
}

export async function readPublishedFaqs(app: App, role: string) {
  const records = await app.store.list(COLLECTIONS.faqs);
  return records.filter((record) => {
    if (!toBoolean(record.Published)) return false;
    const audience = text(record.Audience).toLowerCase();
    return !audience || audience === 'all' || audience === role;
  }).map((record) => ({
    id: text(record.FaqId),
    question: text(record.Question),
    answer: text(record.Answer),
    sortOrder: Number(record.SortOrder) || 0,
  })).sort((left, right) => left.sortOrder - right.sortOrder || left.question.localeCompare(right.question));
}

async function messagesFor(app: App, ticketIds: string[]) {
  const grouped: Record<string, any[]> = {};
  await Promise.all(ticketIds.map(async (id) => {
    const rows = await app.store.listMessages(id);
    grouped[id] = rows.map((record) => ({
      messageId: text(record.MessageId),
      authorEmail: normalizeEmail(record.AuthorEmail),
      authorRole: text(record.AuthorRole),
      body: text(record.Body),
      createdAt: text(record.CreatedAt),
    }));
  }));
  return grouped;
}

function publicMessage(message: any, includeEmail: boolean, names?: Record<string, string> | null) {
  const item: Doc = { messageId: message.messageId, authorRole: message.authorRole, body: message.body, createdAt: message.createdAt };
  if (includeEmail) item.authorEmail = message.authorEmail;
  if (names && message.authorRole !== 'student') {
    const name = names[normalizeEmail(message.authorEmail)];
    if (name) item.authorName = name;
  }
  return item;
}

async function attachMessages(app: App, tickets: TicketShape[], includeEmail: boolean) {
  const messages = await messagesFor(app, tickets.map((ticket) => text(ticket.ticketId)));
  const names = includeEmail ? null : await staffDisplayNames(app);
  return tickets.map((ticket) => ({
    ...ticket,
    routeLabel: routeLabel(ticket),
    messages: (messages[text(ticket.ticketId)] || []).map((message) => publicMessage(message, includeEmail, names)),
  }));
}

function withShareControls(tickets: any[], user: HubUser) {
  return tickets.map((ticket) => {
    ticket.authorEmail = ticketAuthorEmail(ticket);
    ticket.canShare = !!(user && ticket.authorEmail === user.email);
    ticket.kind = ticket.shared ? 'message' : 'note';
    return ticket;
  });
}

async function staffDisplayNames(app: App): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const staff = await app.store.list(COLLECTIONS.staffUsers);
  staff.forEach((row) => {
    const email = normalizeEmail(row.EMAIL);
    if (email) names[email] = text(row.DisplayName) || email;
  });
  return names;
}

function applyAuthorNames(ticket: any, names: Record<string, string>) {
  const authorEmail = normalizeEmail(ticket.authorEmail || ticket.assignee);
  ticket.authorName = names[authorEmail] || authorEmail || 'Staff';
  (ticket.messages || []).forEach((message: any) => {
    const email = normalizeEmail(message.authorEmail);
    if (message.authorRole === 'student') message.authorName = ticket.displayName || email || 'Student';
    else message.authorName = names[email] || email || 'Staff';
  });
}

async function staffMayContributeToNote(app: App, user: HubUser, ticket: TicketShape, viewAs: unknown): Promise<boolean> {
  if (user.role !== 'staff' || !isStaffNote(ticket)) return false;
  const cohortId = text(ticket.cohort);
  if (!cohortId) return false;
  try {
    const roster = (await readRoster(app, cohortId)).find((student) => student.email === ticket.studentId);
    return staffMayViewPlacement(user, normalizeStaffView(user, viewAs), roster);
  } catch {
    return false;
  }
}

function assertFresh(record: Doc, clientToken: unknown) {
  if (text(record.LastUpdated) !== String(clientToken || '')) {
    throw new HubError('This message changed in another tab. Reload it and try again.');
  }
}

async function requireTicketActor(app: App, user: HubUser, ticket: TicketShape, viewAs: unknown) {
  if (user.role === 'student') {
    if (!studentCanSeeTicket(user.email, ticket)) return deny(app, user, 'VIEW_TICKET', 'Students can only open their own messages.');
    return 'student';
  }
  const view = normalizeStaffView(user, viewAs);
  const placement = await findPlacement(app, ticket.studentId);
  if (staffCanSeeTicket(user, view, ticket, placement) || ticketAuthorEmail(ticket) === user.email) return view;
  if (await staffMayContributeToNote(app, user, ticket, viewAs)) return view;
  return deny(app, user, 'VIEW_TICKET', 'This message is not in your queue.');
}

async function assertTicketActor(app: App, user: HubUser, ticket: TicketShape, viewAs: unknown) {
  if (user.role === 'student') {
    if (!studentCanSeeTicket(user.email, ticket)) throw new HubError('You cannot update this message.');
    return;
  }
  const view = normalizeStaffView(user, viewAs);
  const placement = await findPlacement(app, ticket.studentId);
  if (staffCanSeeTicket(user, view, ticket, placement) || ticketAuthorEmail(ticket) === user.email) return;
  if (await staffMayContributeToNote(app, user, ticket, viewAs)) return;
  throw new HubError('You cannot update this message.');
}

function ticketAudit(ticket: any, extra?: Doc) {
  const detail: Doc = {
    ticketId: ticket.ticketId || ticket.TicketId,
    studentId: ticket.studentId || normalizeEmail(ticket.StudentId),
    category: ticket.category || text(ticket.Category),
    route: ticket.route || text(ticket.Route),
    status: ticket.status || text(ticket.Status),
  };
  if (extra) Object.assign(detail, extra);
  return detail;
}

export async function replyTicket(app: App, ticketId: unknown, body: unknown, lastUpdated: unknown, viewAs: unknown) {
  const user = await requireUser(app, 'TICKET_REPLY');
  const message = text(body);
  if (!message) throw new HubError('Write a message before sending.');
  if (message.length > 2000) throw new HubError('Replies must be 2,000 characters or fewer.');
  const preview = await loadTicket(app, text(ticketId));
  if (!preview) throw new HubError('This message no longer exists.');
  if (!isStaffNote(ticketFromRecord(preview))) throw new HubError('Chat messages are sent from the student chat.');
  await requireTicketActor(app, user, ticketFromRecord(preview), viewAs);
  return audited(app, user, 'TICKET_REPLY', { ...ticketAudit(preview), bodyHash: textHash(message) }, async () => {
    const current = await loadTicket(app, text(ticketId));
    if (!current) throw new HubError('This message no longer exists.');
    const ticket = ticketFromRecord(current);
    if (!isStaffNote(ticket)) throw new HubError('Chat messages are sent from the student chat.');
    await assertTicketActor(app, user, ticket, viewAs);
    assertFresh(current, lastUpdated);
    const now = nowIso();
    let status = ticket.status;
    if (user.role === 'staff' && status === 'Open' && !isStaffNote(ticket)) status = 'In Progress';
    current.Status = status;
    current.LastUpdated = now;
    current.LastActor = user.email;
    if (isStaffNote(ticket) && !ticket.shared) {
      current.StudentUnread = false;
      current.StaffUnread = false;
    } else {
      current.StudentUnread = user.role === 'staff';
      current.StaffUnread = user.role === 'student';
    }
    await app.store.set(COLLECTIONS.tickets, ticket.ticketId || '', current);
    const messageId = uuid();
    await app.store.addMessage(ticket.ticketId || '', messageId, {
      MessageId: messageId,
      TicketId: ticket.ticketId,
      AuthorEmail: user.email,
      AuthorRole: user.role === 'staff' ? 'staff' : 'student',
      Body: message,
      CreatedAt: now,
    });
    return { ticketId: ticket.ticketId, status, lastUpdated: now };
  });
}

export async function markTicketRead(app: App, ticketId: unknown, lastUpdated: unknown, viewAs: unknown) {
  const user = await requireUser(app, 'TICKET_READ');
  const preview = await loadTicket(app, text(ticketId));
  if (!preview) throw new HubError('This message no longer exists.');
  const ticket = ticketFromRecord(preview);
  await requireTicketActor(app, user, ticket, viewAs);
  const flag = user.role === 'student' ? 'StudentUnread' : 'StaffUnread';
  if (!toBoolean(preview[flag])) return { ticketId: ticket.ticketId, lastUpdated: ticket.lastUpdated, changed: false };
  return audited(app, user, 'TICKET_READ', ticketAudit(preview), async () => {
    const current = await loadTicket(app, text(ticketId));
    if (!current) throw new HubError('This message no longer exists.');
    await assertTicketActor(app, user, ticketFromRecord(current), viewAs);
    assertFresh(current, lastUpdated);
    if (!toBoolean(current[flag])) return { ticketId: text(current.TicketId), lastUpdated: text(current.LastUpdated), changed: false };
    const now = nowIso();
    current[flag] = false;
    current.LastUpdated = now;
    current.LastActor = user.email;
    await app.store.set(COLLECTIONS.tickets, text(current.TicketId), current);
    return { ticketId: text(current.TicketId), lastUpdated: now, changed: true };
  });
}

export async function setMessageShared(app: App, ticketId: unknown, shared: unknown, lastUpdated: unknown, viewAs: unknown) {
  const user = await requireUser(app, 'TICKET_SHARE');
  const wantShared = toBoolean(shared);
  const preview = await loadTicket(app, text(ticketId));
  if (!preview) throw new HubError('This message no longer exists.');
  const ticket = ticketFromRecord(preview);
  if (ticketAuthorEmail(ticket) !== user.email) return deny(app, user, 'TICKET_SHARE', 'Only the author can change who sees this.');
  if (user.role === 'staff') normalizeStaffView(user, viewAs);
  if (ticket.shared === wantShared) {
    return { ticketId: ticket.ticketId, shared: ticket.shared, lastUpdated: ticket.lastUpdated, kind: ticket.shared ? 'message' : 'note' };
  }
  return audited(app, user, 'TICKET_SHARE', { ...ticketAudit(preview), shared: wantShared }, async () => {
    const current = await loadTicket(app, text(ticketId));
    if (!current) throw new HubError('This message no longer exists.');
    const fresh = ticketFromRecord(current);
    if (ticketAuthorEmail(fresh) !== user.email) throw new HubError('Only the author can change who sees this.');
    assertFresh(current, lastUpdated);
    const now = nowIso();
    current.Shared = wantShared;
    current.LastUpdated = now;
    current.LastActor = user.email;
    if (wantShared) {
      if (user.role === 'staff') current.StudentUnread = true;
      else current.StaffUnread = true;
    } else if (user.role === 'staff') current.StudentUnread = false;
    else current.StaffUnread = false;
    await app.store.set(COLLECTIONS.tickets, text(current.TicketId), current);
    return { ticketId: fresh.ticketId, shared: wantShared, lastUpdated: now, kind: wantShared ? 'message' : 'note' };
  });
}

async function presentNotes(app: App, tickets: TicketShape[], user: HubUser, placements?: Record<string, any>) {
  const names = await staffDisplayNames(app);
  const notes = withShareControls(await attachMessages(app, tickets, true), user).map((ticket) => {
    const placement = placements ? placements[ticket.studentId] : null;
    ticket.displayName = placement ? placement.displayName : ticket.studentId;
    applyAuthorNames(ticket, names);
    return ticket;
  });
  return notes.sort(compareRecentActivity);
}

export async function createStaffNote(app: App, studentEmail: unknown, cohortId: unknown, titleText: unknown, textBody: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'NOTE_CREATE');
  const title = text(titleText).replace(/\s+/g, ' ');
  const body = text(textBody);
  if (!title) throw new HubError('Add a title.');
  if (title.length > 90) throw new HubError('Titles must be 90 characters or fewer.');
  if (!body) throw new HubError('Write a note before saving.');
  if (body.length > 2000) throw new HubError('Notes must be 2,000 characters or fewer.');
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'NOTE_CREATE', viewAs);
  if (!staffMayAddStudentTodo(user, context)) return deny(app, user, 'NOTE_CREATE', 'You cannot take notes for this student.');
  const route = context.view === 'coordinator' ? 'coordinator' : 'supervisor';
  const now = nowIso();
  const ticketId = uuid();
  const record = {
    TicketId: ticketId,
    StudentId: context.email,
    Cohort: text(cohortId),
    Category: 'Note',
    Title: title,
    Status: 'Open',
    Route: route,
    Assignee: user.email,
    CreatedAt: now,
    LastUpdated: now,
    LastActor: user.email,
    StudentUnread: false,
    StaffUnread: false,
    Shared: false,
  };
  return audited(app, user, 'NOTE_CREATE', { ...ticketAudit(record), title, bodyHash: textHash(body) }, async () => {
    await app.store.set(COLLECTIONS.tickets, ticketId, record);
    const messageId = uuid();
    await app.store.addMessage(ticketId, messageId, {
      MessageId: messageId,
      TicketId: ticketId,
      AuthorEmail: user.email,
      AuthorRole: 'staff',
      Body: body,
      CreatedAt: now,
    });
    return { ticketId, shared: false, lastUpdated: now };
  });
}

function noteStudents(user: HubUser, view: string, tables: StaffTables) {
  const students: any[] = [];
  const seen: Record<string, boolean> = {};
  tables.activeCohorts.forEach((cohort) => {
    (tables.byCohort[cohort.id] || []).forEach((student) => {
      const key = `${student.cohortId}|${student.email}`;
      if (seen[key]) return;
      const assigned = student.supervisorId === user.email;
      const allowed = view === 'supervisor' ? !!user.permissions?.isSupervisor && assigned : view === 'coordinator' && !!user.permissions?.canAdmin;
      if (!allowed) return;
      seen[key] = true;
      students.push({ email: student.email, displayName: student.displayName, cohortId: student.cohortId, subject: student.subject || '' });
    });
  });
  students.sort((left, right) => left.displayName.localeCompare(right.displayName) || String(left.cohortId).localeCompare(String(right.cohortId)));
  return students;
}

export async function getStaffNotesHub(app: App, viewAs: unknown) {
  const user = await requireStaff(app, 'VIEW_NOTES');
  if (!user.permissions?.isSupervisor && !user.permissions?.canAdmin) return deny(app, user, 'VIEW_NOTES', 'Supervisors and coordinators keep notes.');
  const view = normalizeStaffView(user, viewAs);
  const tables = await readStaffTables(app);
  const students = noteStudents(user, view, tables);
  const visible = staffNotesForRoster(await readAllTickets(app), students.map((student) => student.email));
  return {
    viewAs: view,
    notes: await presentNotes(app, visible, user, tables.byEmail),
    students,
    templates: await listTodoTemplatesFor(app, user.email),
    phases: await readPhases(app),
  };
}

export async function getStaffStudentPanel(app: App, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'VIEW_STUDENT_NOTES');
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'VIEW_STUDENT_NOTES', viewAs);
  const placements: Record<string, any> = { [context.email]: context.roster };
  const notes = staffNotesForStudent(await readAllTickets(app), context.email);
  return {
    canWrite: staffMayAddStudentTodo(user, context),
    studentEmail: context.email,
    displayName: context.roster.displayName,
    notes: await presentNotes(app, notes, user, placements),
    templates: await listTodoTemplatesFor(app, user.email),
    phases: await readPhases(app, text(cohortId)),
  };
}

