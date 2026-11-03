// One chat per student per cohort. Human lines and Google Docs threads
// share the entries subcollection. UnreadFor lists the emails that still
// need to open the chat.

import { parseDriveId } from './drive';
import {
  ChatAuthorKind,
  ChatEntryView,
  docCommentEntryId,
  emailsOf,
  isDocCommentCategory,
  legacyDocEntryId,
  presentChatEntry,
  swapUnread,
  unreadAfterPost,
} from './chatPure';
import { HubUser, normalizeStaffView } from './permissions';
import {
  findCurrentPlacement,
  leadBySupervisor,
  leadIdForSupervisor,
  listCohorts,
  placementFromMember,
  readStaffTables,
  staffMayViewPlacement,
  staffStudentContext,
} from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, deny, requireStaff, requireUser } from './session';
import { isStaffNote, ticketFromRecord, ticketIsShared } from './ticketsPure';
import { Doc, HubError, normalizeEmail, nowIso, text, textHash, uuid } from './util';

const BODY_LIMIT = 2000;

function hasChatStore(app: App): boolean {
  return typeof app.store.getChat === 'function' && typeof app.store.listChatEntries === 'function';
}

async function staffNames(app: App): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const staff = await app.store.list(COLLECTIONS.staffUsers);
  staff.forEach((row) => {
    const email = normalizeEmail(row.EMAIL);
    if (email) names[email] = text(row.DisplayName) || email;
  });
  return names;
}

function laterStamp(previous: string): string {
  const now = Date.now();
  const prior = Date.parse(text(previous));
  if (Number.isNaN(prior)) return new Date(now).toISOString();
  return new Date(Math.max(now, prior + 1)).toISOString();
}

function assertChatFresh(record: Doc, clientToken: unknown, openChat: boolean) {
  const token = clientToken === undefined || clientToken === null ? '' : String(clientToken);
  if (!token && openChat) return;
  if (text(record.LastUpdated) !== token) {
    throw new HubError('This message changed in another tab. Reload it and try again.');
  }
}

async function humanLines(app: App, cohortId: string, studentId: string): Promise<boolean> {
  const rows = await app.store.listChatEntries(cohortId, studentId);
  return rows.some((row) => text(row.Kind) !== 'doc-comment');
}

function blankChat(cohortId: string, studentId: string, supervisorId: string, leadId: string, docUrl: string, fileId: string, now: string): Doc {
  return {
    StudentId: studentId,
    Cohort: cohortId,
    SupervisorId: supervisorId,
    LeadId: leadId,
    CreatedAt: now,
    LastUpdated: now,
    LastActor: '',
    UnreadFor: [],
    DocFileId: fileId,
    DocUrl: docUrl,
    CommentCursor: '',
    CommentLastAttemptAt: '',
    CommentSyncStatus: '',
    CommentSyncError: '',
    LegacyImported: true,
  };
}

async function earliestMembership(app: App, studentId: string): Promise<string> {
  const cohorts = await listCohorts(app, true);
  for (const cohort of cohorts) {
    const member = await app.store.getMember(cohort.id, studentId);
    if (member && normalizeEmail(member.StudentId)) return cohort.id;
  }
  return '';
}

async function importLegacy(app: App, cohortId: string, studentId: string, chat: Doc): Promise<void> {
  if (typeof app.store.listMessages !== 'function') return;
  const homeCohort = await earliestMembership(app, studentId);
  const tickets = await app.store.list(COLLECTIONS.tickets);
  let latestAt = '';
  let latestRole = '';
  for (const record of tickets) {
    const ticket = ticketFromRecord(record);
    if (ticket.studentId !== studentId || isStaffNote(ticket) || !ticketIsShared(record)) continue;
    const ticketCohort = text(ticket.cohort);
    if (ticketCohort && ticketCohort !== cohortId) continue;
    if (!ticketCohort && homeCohort !== cohortId) continue;
    const messages = await app.store.listMessages(ticket.ticketId || '');
    if (isDocCommentCategory(ticket.category)) {
      const first = messages[0];
      const entryId = legacyDocEntryId(ticket.ticketId || '');
      await app.store.setChatEntry(cohortId, studentId, entryId, {
        EntryId: entryId,
        Kind: 'doc-comment',
        FileId: '',
        ThreadId: '',
        CommentId: '',
        DocUrl: '',
        AuthorName: '',
        AuthorEmail: normalizeEmail(first?.AuthorEmail),
        AuthorRole: text(first?.AuthorRole),
        Body: text(first?.Body) || text(ticket.title),
        Quote: '',
        CreatedAt: text(first?.CreatedAt) || text(ticket.createdAt),
        ModifiedAt: text(ticket.lastUpdated) || text(first?.CreatedAt),
        Resolved: false,
        Deleted: false,
        ReplyCount: 0,
        RepliesJson: '[]',
      });
    } else {
      for (const message of messages) {
        const entryId = text(message.MessageId) || uuid();
        const createdAt = text(message.CreatedAt);
        await app.store.setChatEntry(cohortId, studentId, entryId, {
          EntryId: entryId,
          Kind: 'chat',
          AuthorEmail: normalizeEmail(message.AuthorEmail),
          AuthorRole: text(message.AuthorRole) || 'staff',
          AuthorName: '',
          Body: text(message.Body),
          CreatedAt: createdAt,
        });
        if (createdAt >= latestAt) {
          latestAt = createdAt;
          latestRole = text(message.AuthorRole);
        }
      }
    }
    for (const message of messages) {
      if (typeof app.store.removeMessage === 'function') await app.store.removeMessage(ticket.ticketId || '', text(message.MessageId));
    }
    if (typeof app.store.remove === 'function') await app.store.remove(COLLECTIONS.tickets, ticket.ticketId || '');
  }
  if (typeof app.store.whereEqual === 'function') {
    const threads = await app.store.whereEqual(COLLECTIONS.docCommentThreads, 'StudentId', studentId);
    const fileId = text(chat.DocFileId);
    for (const row of threads) {
      const rowCohort = text(row.Cohort);
      const rowFile = text(row.FileId);
      if (rowCohort && rowCohort !== cohortId) continue;
      if (!rowCohort && fileId && rowFile && rowFile !== fileId) continue;
      if (!rowCohort && !fileId) continue;
      const threadId = text(row.ThreadId);
      if (!rowFile || !threadId) continue;
      const entryId = docCommentEntryId(rowFile, threadId);
      await app.store.setChatEntry(cohortId, studentId, entryId, {
        ...row,
        EntryId: entryId,
        Kind: 'doc-comment',
        CommentId: threadId,
      });
      if (typeof app.store.remove === 'function' && text(row.Id)) await app.store.remove(COLLECTIONS.docCommentThreads, text(row.Id));
    }
    const syncId = `${studentId}__${fileId}`;
    if (fileId && typeof app.store.get === 'function') {
      const cursor = await app.store.get(COLLECTIONS.docCommentSync, syncId);
      if (cursor) {
        chat.CommentCursor = text(cursor.LastSuccessAt);
        chat.CommentLastAttemptAt = text(cursor.LastAttemptAt);
        chat.CommentSyncStatus = text(cursor.Status);
        chat.CommentSyncError = text(cursor.Error).slice(0, 300);
        // Legacy cursor docs are copied once. Live sweep rows carry DueAt and stay in place.
        if (typeof cursor.DueAt !== 'number' && typeof app.store.remove === 'function') {
          await app.store.remove(COLLECTIONS.docCommentSync, syncId);
        }
      }
    }
  }
  if (latestAt) {
    chat.LastUpdated = latestAt;
    chat.LastActor = latestRole === 'student' ? studentId : text(chat.SupervisorId);
    const author: ChatAuthorKind = latestRole === 'student' ? 'student' : 'supervisor';
    chat.UnreadFor = unreadAfterPost(author, studentId, text(chat.SupervisorId), text(chat.LeadId));
  }
}

function refreshChat(chat: Doc, supervisorId: string, leadId: string, docUrl: string, fileId: string): boolean {
  let unread = emailsOf(chat.UnreadFor);
  const previousSupervisor = normalizeEmail(chat.SupervisorId);
  const previousLead = normalizeEmail(chat.LeadId);
  if (previousSupervisor !== supervisorId) unread = swapUnread(unread, previousSupervisor, supervisorId);
  if (previousLead !== leadId) unread = swapUnread(unread, previousLead, leadId);
  const fileChanged = !!fileId && fileId !== text(chat.DocFileId);
  const changed = previousSupervisor !== supervisorId
    || previousLead !== leadId
    || fileChanged
    || text(chat.DocUrl) !== docUrl
    || emailsOf(chat.UnreadFor).join('\n') !== unread.join('\n');
  chat.SupervisorId = supervisorId;
  chat.LeadId = leadId;
  chat.UnreadFor = unread;
  if (fileId) {
    if (fileChanged) {
      chat.CommentCursor = '';
      chat.CommentLastAttemptAt = '';
      chat.CommentSyncStatus = '';
      chat.CommentSyncError = '';
    }
    chat.DocFileId = fileId;
    chat.DocUrl = docUrl;
  }
  return changed;
}

export async function ensureCohortChat(app: App, cohortId: string, studentEmail: string): Promise<Doc | null> {
  if (!hasChatStore(app)) return null;
  const email = normalizeEmail(studentEmail);
  const cohort = text(cohortId);
  if (!email || !cohort) return null;
  const member = await app.store.getMember(cohort, email);
  const profile = member ? await app.store.get(COLLECTIONS.studentUsers, email) : null;
  const placement = member ? placementFromMember(cohort, member, profile) : null;
  const supervisorId = placement?.supervisorId || '';
  const leadId = await leadIdForSupervisor(app, supervisorId);
  const docUrl = placement?.doc || '';
  const fileId = parseDriveId(docUrl);
  const existing = await app.store.getChat(cohort, email);
  if (existing) {
    if (refreshChat(existing, supervisorId, leadId, docUrl, fileId)) await app.store.setChat(cohort, email, existing);
    return existing;
  }
  const now = nowIso();
  const chat = blankChat(cohort, email, supervisorId, leadId, docUrl, fileId, now);
  await importLegacy(app, cohort, email, chat);
  await app.store.setChat(cohort, email, chat);
  return chat;
}

async function presentEntries(app: App, cohortId: string, studentId: string, studentName: string): Promise<ChatEntryView[]> {
  const names = await staffNames(app);
  const rows = await app.store.listChatEntries(cohortId, studentId);
  return rows
    .map((row) => presentChatEntry(row, names, studentName))
    .filter((row): row is ChatEntryView => !!row)
    .sort((left, right) => left.at.localeCompare(right.at) || left.entryId.localeCompare(right.entryId));
}

async function clearReader(app: App, cohortId: string, chat: Doc, email: string): Promise<Doc> {
  const unread = emailsOf(chat.UnreadFor);
  if (!unread.includes(email)) return chat;
  chat.UnreadFor = unread.filter((item) => item !== email);
  chat.LastUpdated = nowIso();
  chat.LastActor = email;
  await app.store.setChat(cohortId, text(chat.StudentId), chat);
  return chat;
}

function previewTitle(entries: ChatEntryView[]): string {
  const lines = entries.filter((entry) => entry.kind === 'chat');
  const last = lines[lines.length - 1];
  if (!last) return 'Chat';
  const line = text(last.body).split('\n')[0] || 'Chat';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export async function getStudentChat(app: App) {
  const user = await requireUser(app, 'VIEW_STUDENT_CHAT');
  if (user.role !== 'student') return deny(app, user, 'VIEW_STUDENT_CHAT', 'Student access required.');
  const placement = await findCurrentPlacement(app, user.email);
  if (!placement) {
    return { cohortId: '', studentEmail: user.email, displayName: user.displayName, lastUpdated: '', canCompose: false, entries: [] };
  }
  const chat = await ensureCohortChat(app, placement.cohortId, placement.email);
  if (!chat) return { cohortId: placement.cohortId, studentEmail: placement.email, displayName: placement.displayName, lastUpdated: '', canCompose: true, entries: [] };
  const opened = await clearReader(app, placement.cohortId, chat, user.email);
  return {
    cohortId: placement.cohortId,
    studentEmail: placement.email,
    displayName: placement.displayName,
    lastUpdated: text(opened.LastUpdated),
    canCompose: true,
    viewerEmail: user.email,
    entries: await presentEntries(app, placement.cohortId, placement.email, placement.displayName),
  };
}

export async function sendStudentChat(app: App, body: unknown, lastUpdated: unknown) {
  const user = await requireUser(app, 'SEND_STUDENT_CHAT');
  if (user.role !== 'student') return deny(app, user, 'SEND_STUDENT_CHAT', 'Student access required.');
  const message = text(body);
  if (!message) throw new HubError('Write a message before sending.');
  if (message.length > BODY_LIMIT) throw new HubError('Messages must be 2,000 characters or fewer.');
  const placement = await findCurrentPlacement(app, user.email);
  if (!placement) throw new HubError('You are not on a cohort roster yet.');
  const preview = await ensureCohortChat(app, placement.cohortId, placement.email);
  if (!preview) throw new HubError('Chat is not available.');
  const open = !(await humanLines(app, placement.cohortId, placement.email)) && !text(preview.LastActor);
  assertChatFresh(preview, lastUpdated, open);
  return audited(app, user, 'CHAT_SEND', { studentId: placement.email, cohort: placement.cohortId, bodyHash: textHash(message) }, async () => {
    const current = await app.store.getChat(placement.cohortId, placement.email);
    if (!current) throw new HubError('Chat is not available.');
    const stillOpen = !(await humanLines(app, placement.cohortId, placement.email)) && !text(current.LastActor);
    assertChatFresh(current, lastUpdated, stillOpen);
    const now = laterStamp(text(current.LastUpdated));
    const entryId = uuid();
    await app.store.setChatEntry(placement.cohortId, placement.email, entryId, {
      EntryId: entryId,
      Kind: 'chat',
      AuthorEmail: user.email,
      AuthorRole: 'student',
      AuthorName: placement.displayName || user.displayName,
      Body: message,
      CreatedAt: now,
    });
    current.LastUpdated = now;
    current.LastActor = user.email;
    current.UnreadFor = unreadAfterPost('student', placement.email, text(current.SupervisorId), text(current.LeadId));
    await app.store.setChat(placement.cohortId, placement.email, current);
    return { cohortId: placement.cohortId, studentEmail: placement.email, lastUpdated: now, created: false };
  });
}

function authorKind(user: HubUser, view: string): ChatAuthorKind {
  if (view === 'lead') return 'lead';
  if (view === 'coordinator') return 'coordinator';
  if (user.role === 'student') return 'student';
  return 'supervisor';
}

export function staffMaySendStudentChat(
  user: HubUser,
  view: string,
  roster?: { supervisorId?: string } | null,
  leadId?: string,
): boolean {
  if (!user || user.role !== 'staff' || !roster) return false;
  if (view === 'coordinator') return !!user.permissions?.canAdmin;
  if (view === 'lead') {
    if (!user.permissions?.isLead) return false;
    const supervisor = normalizeEmail(roster.supervisorId);
    return !!supervisor && normalizeEmail(leadId) === user.email;
  }
  if (view !== 'supervisor' || !user.permissions?.isSupervisor) return false;
  const assigned = normalizeEmail(roster.supervisorId);
  return !!assigned && assigned === user.email;
}

async function requireStudentChat(app: App, operation: string, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const user = await requireStaff(app, operation);
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), operation, viewAs);
  if (!staffMaySendStudentChat(user, context.view, context.roster, context.leadId)) {
    return deny(app, user, operation, 'Supervisors, leads, and coordinators send messages in this chat.');
  }
  return { user, context };
}

export async function getStaffStudentChat(app: App, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const { user, context } = await requireStudentChat(app, 'VIEW_STUDENT_CHAT', studentEmail, cohortId, viewAs);
  const chat = await ensureCohortChat(app, context.roster.cohortId, context.email);
  if (!chat) {
    return {
      viewAs: context.view,
      canCompose: true,
      studentEmail: context.email,
      displayName: context.roster.displayName || context.email,
      viewerEmail: user.email,
      cohortId: context.roster.cohortId,
      lastUpdated: '',
      entries: [],
    };
  }
  const opened = await clearReader(app, context.roster.cohortId, chat, user.email);
  return {
    viewAs: context.view,
    canCompose: true,
    studentEmail: context.email,
    displayName: context.roster.displayName || context.email,
    viewerEmail: user.email,
    cohortId: context.roster.cohortId,
    lastUpdated: text(opened.LastUpdated),
    entries: await presentEntries(app, context.roster.cohortId, context.email, context.roster.displayName || ''),
  };
}

export async function sendStaffStudentChat(app: App, studentEmail: unknown, cohortId: unknown, body: unknown, lastUpdated: unknown, viewAs: unknown) {
  const message = text(body);
  if (!message) throw new HubError('Write a message before sending.');
  if (message.length > BODY_LIMIT) throw new HubError('Messages must be 2,000 characters or fewer.');
  const { user, context } = await requireStudentChat(app, 'SEND_STUDENT_CHAT', studentEmail, cohortId, viewAs);
  const preview = await ensureCohortChat(app, context.roster.cohortId, context.email);
  if (!preview) throw new HubError('Chat is not available.');
  const open = !(await humanLines(app, context.roster.cohortId, context.email)) && !text(preview.LastActor);
  assertChatFresh(preview, lastUpdated, open);
  const names = await staffNames(app);
  return audited(app, user, 'CHAT_SEND', {
    studentId: context.email,
    cohort: context.roster.cohortId,
    bodyHash: textHash(message),
    via: 'student-chat',
  }, async () => {
    const current = await app.store.getChat(context.roster.cohortId, context.email);
    if (!current) throw new HubError('Chat is not available.');
    const existed = await humanLines(app, context.roster.cohortId, context.email);
    assertChatFresh(current, lastUpdated, !existed && !text(current.LastActor));
    const now = laterStamp(text(current.LastUpdated));
    const entryId = uuid();
    const kind = authorKind(user, context.view);
    await app.store.setChatEntry(context.roster.cohortId, context.email, entryId, {
      EntryId: entryId,
      Kind: 'chat',
      AuthorEmail: user.email,
      AuthorRole: 'staff',
      AuthorName: names[user.email] || user.displayName || user.email,
      Body: message,
      CreatedAt: now,
    });
    current.LastUpdated = now;
    current.LastActor = user.email;
    current.UnreadFor = unreadAfterPost(kind, context.email, text(current.SupervisorId), text(current.LeadId));
    await app.store.setChat(context.roster.cohortId, context.email, current);
    return { cohortId: context.roster.cohortId, studentEmail: context.email, lastUpdated: now, created: !existed };
  });
}

export async function studentChatNotice(app: App, email: string) {
  const wanted = normalizeEmail(email);
  const placement = await findCurrentPlacement(app, wanted);
  if (!placement || !hasChatStore(app)) return { count: 0, title: '', chats: [] as Doc[] };
  const chat = await ensureCohortChat(app, placement.cohortId, placement.email);
  if (!chat || !emailsOf(chat.UnreadFor).includes(wanted)) return { count: 0, title: '', chats: [] };
  const entries = await presentEntries(app, placement.cohortId, placement.email, placement.displayName);
  const title = previewTitle(entries);
  return {
    count: 1,
    title,
    chats: [{
      studentEmail: placement.email,
      cohortId: placement.cohortId,
      displayName: placement.displayName,
      title,
      lastUpdated: text(chat.LastUpdated),
    }],
  };
}

export async function staffChatNotices(app: App, user: HubUser, view: string) {
  if (!hasChatStore(app) || view === 'staff') return { count: 0, chats: [] as Doc[] };
  const tables = await readStaffTables(app);
  const leads = view === 'lead' ? await leadBySupervisor(app) : {};
  const chats: Doc[] = [];
  for (const cohort of tables.activeCohorts) {
    const rows = await app.store.listChats(cohort.id);
    for (const chat of rows) {
      if (!emailsOf(chat.UnreadFor).includes(user.email)) continue;
      const studentId = normalizeEmail(chat.StudentId);
      const placement = (tables.byCohort[cohort.id] || []).find((student) => student.email === studentId);
      if (!placement) continue;
      const leadId = leads[placement.supervisorId] || normalizeEmail(chat.LeadId);
      if (view === 'supervisor' && placement.supervisorId !== user.email) continue;
      if (view === 'lead' && leadId !== user.email) continue;
      if (view === 'coordinator' && !user.permissions?.canAdmin) continue;
      if (!staffMayViewPlacement(user, view, placement, leadId) && view !== 'coordinator') continue;
      const entries = await presentEntries(app, cohort.id, studentId, placement.displayName);
      chats.push({
        studentEmail: studentId,
        cohortId: cohort.id,
        displayName: placement.displayName,
        title: previewTitle(entries),
        lastUpdated: text(chat.LastUpdated),
      });
    }
  }
  chats.sort((left, right) => text(right.lastUpdated).localeCompare(text(left.lastUpdated)));
  return { count: chats.length, chats: chats.slice(0, 20) };
}

export async function getOpeningMessages(app: App) {
  const user = await requireUser(app, 'VIEW_STUDENT_CHAT');
  if (user.role === 'student') {
    const notice = await studentChatNotice(app, user.email);
    return { active: 'student', studentUnread: notice.count, title: notice.title };
  }
  if (!user.permissions?.isSupervisor && !user.permissions?.canAdmin && !user.permissions?.isLead) return { active: 'staff', staffUnread: 0 };
  const view = normalizeStaffView(user, user.permissions?.canAdmin ? 'coordinator' : (user.permissions?.isSupervisor ? 'supervisor' : 'lead'));
  const notice = await staffChatNotices(app, user, view);
  return { active: view, staffUnread: notice.count };
}
