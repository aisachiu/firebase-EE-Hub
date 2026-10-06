import { listTodoTemplatesFor } from './actions';
import { HubUser, normalizeStaffView } from './permissions';
import { findPlacement, readPhases, readStaffTables, staffMayAddStudentTodo, staffStudentContext, StaffTables } from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, deny, requireStaff, requireUser } from './session';
import { assigneeForRoute, DEFAULT_TICKET_CATEGORIES, routeLabel, staffCanSeeTicket, studentCanSeeTicket, ticketAuthorEmail, ticketChip, ticketFromRecord, TicketShape } from './ticketsPure';
import { Doc, HubError, normalizeEmail, nowIso, text, textHash, toBoolean, uuid } from './util';

const TICKET_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];

export async function readTicketCategories(app: App) {
  let records = await app.store.list(COLLECTIONS.ticketCategories);
  if (!records.length) {
    for (const category of DEFAULT_TICKET_CATEGORIES) {
      await app.store.set(COLLECTIONS.ticketCategories, category.id, {
        CategoryId: category.id,
        Name: category.name,
        Route: category.route,
        SortOrder: category.sort,
        Active: true,
      });
    }
    records = await app.store.list(COLLECTIONS.ticketCategories);
  }
  return records.map((record) => ({
    id: text(record.CategoryId),
    name: text(record.Name),
    route: text(record.Route).toLowerCase(),
    sortOrder: Number(record.SortOrder) || 0,
    active: toBoolean(record.Active),
  })).filter((category) => category.name && (category.route === 'supervisor' || category.route === 'coordinator'))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
}

async function categoryByName(app: App, name: unknown) {
  const wanted = text(name);
  const categories = await readTicketCategories(app);
  return categories.find((category) => category.active && category.name === wanted) || null;
}

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

function publicMessage(message: any, includeEmail: boolean) {
  const item: Doc = { messageId: message.messageId, authorRole: message.authorRole, body: message.body, createdAt: message.createdAt };
  if (includeEmail) item.authorEmail = message.authorEmail;
  return item;
}

async function attachMessages(app: App, tickets: TicketShape[], includeEmail: boolean) {
  const messages = await messagesFor(app, tickets.map((ticket) => text(ticket.ticketId)));
  return tickets.map((ticket) => ({
    ...ticket,
    routeLabel: routeLabel(ticket),
    messages: (messages[text(ticket.ticketId)] || []).map((message) => publicMessage(message, includeEmail)),
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

function sortTickets<T extends { lastUpdated?: string }>(tickets: T[], unreadKey: string) {
  return tickets.sort((left: any, right: any) => {
    if (!!left[unreadKey] !== !!right[unreadKey]) return left[unreadKey] ? -1 : 1;
    return text(right.lastUpdated).localeCompare(text(left.lastUpdated));
  });
}

export async function studentTicketNotice(app: App, email: string) {
  const wanted = normalizeEmail(email);
  const unread = (await readAllTickets(app)).filter((ticket) => ticket.studentId === wanted && ticket.shared && ticket.studentUnread)
    .sort((left, right) => text(right.lastUpdated).localeCompare(text(left.lastUpdated)));
  return {
    count: unread.length,
    title: unread.length ? unread[0].title : '',
    tickets: unread.slice(0, 20).map((ticket) => ({ ticketId: ticket.ticketId, title: ticket.title, category: ticket.category, lastUpdated: ticket.lastUpdated })),
  };
}

async function placementMap(app: App, tickets: TicketShape[], known?: Record<string, any>) {
  const map: Record<string, any> = { ...(known || {}) };
  for (const ticket of tickets) {
    if (map[ticket.studentId]) continue;
    map[ticket.studentId] = await findPlacement(app, ticket.studentId);
  }
  return map;
}

export async function staffUnreadNotices(app: App, user: HubUser, view: string, placements?: Record<string, any>) {
  const tickets = await readAllTickets(app);
  const map = placements || await placementMap(app, tickets);
  const unread = tickets.filter((ticket) => staffCanSeeTicket(user, view, ticket, map[ticket.studentId])).filter((ticket) => ticket.staffUnread)
    .sort((left, right) => text(right.lastUpdated).localeCompare(text(left.lastUpdated)));
  return {
    count: unread.length,
    tickets: unread.slice(0, 20).map((ticket) => ({
      ticketId: ticket.ticketId,
      title: ticket.title,
      category: ticket.category,
      displayName: map[ticket.studentId]?.displayName || ticket.studentId,
      lastUpdated: ticket.lastUpdated,
    })),
  };
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
  if (!staffCanSeeTicket(user, view, ticket, placement)) return deny(app, user, 'VIEW_TICKET', 'This message is not in your queue.');
  return view;
}

async function assertTicketActor(app: App, user: HubUser, ticket: TicketShape, viewAs: unknown) {
  if (user.role === 'student') {
    if (!studentCanSeeTicket(user.email, ticket)) throw new HubError('You cannot update this message.');
    return;
  }
  const view = normalizeStaffView(user, viewAs);
  const placement = await findPlacement(app, ticket.studentId);
  if (!staffCanSeeTicket(user, view, ticket, placement) && ticketAuthorEmail(ticket) !== user.email) {
    throw new HubError('You cannot update this message.');
  }
}

function publicCategories(categories: Awaited<ReturnType<typeof readTicketCategories>>) {
  return categories.filter((item) => item.active).map((item) => ({ name: item.name, route: item.route, chip: ticketChip(item.name) }));
}

export async function getTicketHub(app: App) {
  const user = await requireUser(app, 'VIEW_TICKETS');
  if (user.role !== 'student') return deny(app, user, 'VIEW_TICKETS', 'Student access required.');
  const tickets = sortTickets((await readAllTickets(app)).filter((ticket) => studentCanSeeTicket(user.email, ticket)), 'studentUnread');
  const notice = tickets.filter((ticket) => ticket.studentUnread && ticket.shared);
  const categories = await readTicketCategories(app);
  return {
    faqs: await readPublishedFaqs(app, 'student'),
    categories: publicCategories(categories),
    tickets: withShareControls(await attachMessages(app, tickets, false), user),
    unreadCount: notice.length,
    unreadTitle: notice.length ? notice[0].title : '',
  };
}

export async function createTicket(app: App, payload: any) {
  const user = await requireUser(app, 'TICKET_CREATE');
  if (user.role !== 'student') return deny(app, user, 'TICKET_CREATE', 'Students send messages.');
  const input = payload || {};
  const category = await categoryByName(app, input.category);
  if (!category) throw new HubError('Choose a category.');
  const title = text(input.title);
  const body = text(input.body);
  if (!title) throw new HubError('Add a short subject.');
  if (title.length > 90) throw new HubError('Subject must be 90 characters or fewer.');
  if (!body) throw new HubError('Write your message before sending.');
  if (body.length > 2000) throw new HubError('Messages must be 2,000 characters or fewer.');
  const placement = await findPlacement(app, user.email);
  const assignee = assigneeForRoute(category.route, placement);
  const now = nowIso();
  const ticketId = uuid();
  const record = {
    TicketId: ticketId,
    StudentId: user.email,
    Cohort: placement ? placement.cohortId : '',
    Category: category.name,
    Title: title,
    Status: 'Open',
    Route: category.route,
    Assignee: assignee || '',
    CreatedAt: now,
    LastUpdated: now,
    LastActor: user.email,
    StudentUnread: false,
    StaffUnread: true,
    Shared: true,
  };
  return audited(app, user, 'TICKET_CREATE', { ...ticketAudit(record), bodyHash: textHash(body) }, async () => {
    await app.store.set(COLLECTIONS.tickets, ticketId, record);
    const messageId = uuid();
    await app.store.addMessage(ticketId, messageId, {
      MessageId: messageId,
      TicketId: ticketId,
      AuthorEmail: user.email,
      AuthorRole: 'student',
      Body: body,
      CreatedAt: now,
    });
    return { ticketId, route: category.route, routeLabel: routeLabel(ticketFromRecord(record)), lastUpdated: now };
  });
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
  await requireTicketActor(app, user, ticketFromRecord(preview), viewAs);
  return audited(app, user, 'TICKET_REPLY', { ...ticketAudit(preview), bodyHash: textHash(message) }, async () => {
    const current = await loadTicket(app, text(ticketId));
    if (!current) throw new HubError('This message no longer exists.');
    const ticket = ticketFromRecord(current);
    await assertTicketActor(app, user, ticket, viewAs);
    assertFresh(current, lastUpdated);
    const now = nowIso();
    let status = ticket.status;
    if (user.role === 'staff' && status === 'Open') status = 'In Progress';
    current.Status = status;
    current.LastUpdated = now;
    current.LastActor = user.email;
    current.StudentUnread = user.role === 'staff';
    current.StaffUnread = user.role === 'student';
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

export async function setTicketStatus(app: App, ticketId: unknown, status: unknown, lastUpdated: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'TICKET_STATUS');
  const nextStatus = text(status);
  if (!TICKET_STATUSES.includes(nextStatus)) throw new HubError('Choose a valid status.');
  const preview = await loadTicket(app, text(ticketId));
  if (!preview) throw new HubError('This message no longer exists.');
  await requireTicketActor(app, user, ticketFromRecord(preview), viewAs);
  if (text(preview.Status) === nextStatus) return { ticketId: text(preview.TicketId), status: nextStatus, lastUpdated: text(preview.LastUpdated) };
  return audited(app, user, 'TICKET_STATUS', { ...ticketAudit(preview), status: nextStatus }, async () => {
    const current = await loadTicket(app, text(ticketId));
    if (!current) throw new HubError('This message no longer exists.');
    await assertTicketActor(app, user, ticketFromRecord(current), viewAs);
    assertFresh(current, lastUpdated);
    const now = nowIso();
    current.Status = nextStatus;
    current.LastUpdated = now;
    current.LastActor = user.email;
    await app.store.set(COLLECTIONS.tickets, text(current.TicketId), current);
    return { ticketId: text(current.TicketId), status: nextStatus, lastUpdated: now };
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

async function prepareStaffTickets(app: App, user: HubUser, tickets: TicketShape[]) {
  const attached = withShareControls(await attachMessages(app, tickets, true), user);
  for (const ticket of attached) {
    const placement = await findPlacement(app, ticket.studentId);
    ticket.displayName = placement ? placement.displayName : ticket.studentId;
  }
  return attached;
}

function staffTicketHub(user: HubUser, view: string, prepared: any[], categories: any[]) {
  const queued = sortTickets(prepared.filter((ticket) => staffCanSeeTicket(user, view, ticket, { supervisorId: ticket.supervisorId })), 'staffUnread');
  return { viewAs: view, tickets: queued, unreadCount: queued.filter((ticket) => ticket.staffUnread).length, categories };
}

export async function getStaffTickets(app: App, viewAs: unknown) {
  const user = await requireStaff(app, 'VIEW_TICKETS');
  const view = normalizeStaffView(user, viewAs);
  const tickets = await readAllTickets(app);
  const prepared = await prepareStaffTickets(app, user, tickets);
  for (const ticket of prepared) {
    const placement = await findPlacement(app, ticket.studentId);
    ticket.supervisorId = placement?.supervisorId || '';
  }
  const categories = publicCategories(await readTicketCategories(app));
  return staffTicketHub(user, view, prepared, categories);
}

export async function getStaffTicketBadge(app: App, viewAs: unknown) {
  const user = await requireStaff(app, 'VIEW_TICKETS');
  const view = normalizeStaffView(user, viewAs);
  const tickets = await readAllTickets(app);
  let unread = 0;
  for (const ticket of tickets) {
    const placement = await findPlacement(app, ticket.studentId);
    if (staffCanSeeTicket(user, view, ticket, placement) && ticket.staffUnread) unread += 1;
  }
  return { viewAs: view, unreadCount: unread };
}

export async function getOpeningMessages(app: App) {
  const user = await requireUser(app, 'VIEW_TICKETS');
  if (user.role === 'student') return { active: 'student', student: await getTicketHub(app) };
  if (!user.permissions?.isSupervisor && !user.permissions?.canAdmin) return { active: 'staff' };
  const prepared = await prepareStaffTickets(app, user, await readAllTickets(app));
  for (const ticket of prepared) {
    const placement = await findPlacement(app, ticket.studentId);
    ticket.supervisorId = placement?.supervisorId || '';
  }
  const categories = publicCategories(await readTicketCategories(app));
  const active = user.permissions?.canAdmin ? 'coordinator' : 'supervisor';
  const result: Doc = { active };
  if (user.permissions?.canAdmin) result.coordinator = staffTicketHub(user, 'coordinator', prepared, categories);
  if (user.permissions?.isSupervisor) result.supervisor = staffTicketHub(user, 'supervisor', prepared, categories);
  return result;
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
  const notes = withShareControls(await attachMessages(app, tickets, true), user).map((ticket) => {
    const placement = placements ? placements[ticket.studentId] : null;
    ticket.displayName = placement ? placement.displayName : ticket.studentId;
    return ticket;
  });
  return notes.sort((left, right) => text(right.lastUpdated).localeCompare(text(left.lastUpdated)));
}

export async function createStaffNote(app: App, studentEmail: unknown, cohortId: unknown, textBody: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'NOTE_CREATE');
  const body = text(textBody);
  if (!body) throw new HubError('Write a note before saving.');
  if (body.length > 2000) throw new HubError('Notes must be 2,000 characters or fewer.');
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'NOTE_CREATE', viewAs);
  if (!staffMayAddStudentTodo(user, context)) return deny(app, user, 'NOTE_CREATE', 'You cannot take notes for this student.');
  let title = body.replace(/\s+/g, ' ');
  if (title.length > 90) title = title.slice(0, 90);
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
  return audited(app, user, 'NOTE_CREATE', { ...ticketAudit(record), bodyHash: textHash(body) }, async () => {
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
  const authored = (await readAllTickets(app)).filter((ticket) => ticketAuthorEmail(ticket) === user.email);
  return {
    viewAs: view,
    notes: await presentNotes(app, authored, user, tables.byEmail),
    students: noteStudents(user, view, tables),
    templates: await listTodoTemplatesFor(app, user.email),
    phases: await readPhases(app),
  };
}

export async function getStaffStudentPanel(app: App, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'VIEW_STUDENT_NOTES');
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'VIEW_STUDENT_NOTES', viewAs);
  const placements: Record<string, any> = { [context.email]: context.roster };
  const notes = (await readAllTickets(app)).filter((ticket) => ticket.studentId === context.email && ticketAuthorEmail(ticket) === user.email);
  return {
    canWrite: staffMayAddStudentTodo(user, context),
    studentEmail: context.email,
    displayName: context.roster.displayName,
    notes: await presentNotes(app, notes, user, placements),
    templates: await listTodoTemplatesFor(app, user.email),
    phases: await readPhases(app),
  };
}

export async function validateTicketCategory(app: App, values: Doc, originalKey: string) {
  values.Name = text(values.Name);
  values.Route = text(values.Route).toLowerCase();
  if (values.Name.length > 80) throw new HubError('Category name must be 80 characters or fewer.');
  if (values.Active === undefined || values.Active === '') values.Active = true;
  else values.Active = toBoolean(values.Active);
  const key = text(originalKey || values.CategoryId);
  const categories = await readTicketCategories(app);
  categories.forEach((category) => {
    if (key && category.id === key) return;
    if (category.name.toLowerCase() === values.Name.toLowerCase()) throw new HubError('A message category with this name already exists.');
  });
}
