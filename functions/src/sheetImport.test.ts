import assert from 'node:assert/strict';
import test from 'node:test';
import { dateOnlyFromSheet, dateTimeFromSheet, planSheetImport, SheetGrid, spreadsheetIdFrom } from './sheetImport';

function grid(title: string, headers: string[], rows: unknown[][]): SheetGrid {
  return { title, rows: [headers, ...rows] };
}

test('spreadsheet ids come from a url or a bare id', () => {
  assert.equal(spreadsheetIdFrom('https://docs.google.com/spreadsheets/d/abc123_XYZ-000000000000/edit#gid=0'), 'abc123_XYZ-000000000000');
  assert.equal(spreadsheetIdFrom('abc123_XYZ-000000000000'), 'abc123_XYZ-000000000000');
  assert.throws(() => spreadsheetIdFrom('not a sheet'), /spreadsheet id/);
});

test('sheet serial dates become calendar dates and timestamps', () => {
  const serial = (Date.UTC(2026, 8, 26) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(dateOnlyFromSheet(serial), '2026-09-26');
  assert.equal(dateOnlyFromSheet('2026-09-26'), '2026-09-26');
  assert.equal(dateTimeFromSheet(serial + 15.5 / 24), '2026-09-26T15:30:00.000Z');
});

test('a workbook becomes staff, roster, form answers, and messages', () => {
  const plan = planSheetImport([
    grid('USERS-STAFF', ['EMAIL', 'DisplayName', 'isStaff', 'isCoordinator', 'isAdmin', 'FolderPrefix'], [
      ['Alex.Chen@VSA.EDU', 'Alex Chen', true, true, false, ''],
    ]),
    grid('COHORTS', ['Cohort', 'SheetName', 'Status', 'DriveRootFolderId', 'FolderPrefix', 'FolderSuffix'], [
      ['2026', 'COHORT: 2026', 'Active', '', 'EE ', ''],
    ]),
    grid('COHORT: 2026', ['StudentId', 'Display Name', 'Student ID', 'Student Email', 'Year Group', 'supervisorId', 'Anchor_Date'], [
      ['Jamie.Wong@VSA.EDU', 'Jamie Wong', '20260001', 'Jamie.Wong@VSA.EDU', 12, 'Alex.Chen@VSA.EDU', (Date.UTC(2026, 11, 15) - Date.UTC(1899, 11, 30)) / 86400000],
    ]),
    grid('MILESTONE_TEMPLATES', ['milestoneId', 'type', 'milestoneTitle', 'phase', 'mOwner'], [
      ['m1', 'form', 'Subject preference', 'topic', 'student'],
    ]),
    grid('FORM_DEFINITIONS', ['milestoneId', 'status', 'version', 'fieldsJson', 'html', 'js', 'submitCompletes', 'LastUpdated', 'UpdatedBy'], [
      ['m1', 'Published', 1, JSON.stringify([{ name: 'choice1', type: 'text' }, { name: 'due', type: 'date' }]), '<p></p>', '', true, '2026-10-01T00:00:00.000Z', 'alex.chen@vsa.edu'],
    ]),
    grid('FORM: m1', ['StudentId', 'FormVersion', 'Status', 'SubmittedAt', 'LastUpdated', 'choice1', 'due'], [
      ['Jamie.Wong@VSA.EDU', 1, 'Submitted', '2026-10-02T01:00:00.000Z', '2026-10-02T01:00:00.000Z', 'English', (Date.UTC(2026, 8, 26) - Date.UTC(1899, 11, 30)) / 86400000],
    ]),
    grid('TICKETS', ['TicketId', 'StudentId', 'Category', 'Title', 'Status', 'Route', 'Assignee', 'CreatedAt', 'LastUpdated', 'LastActor', 'Shared'], [
      ['t1', 'Jamie.Wong@VSA.EDU', 'Subject', 'Question', 'Open', 'supervisor', 'Alex.Chen@VSA.EDU', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 'Jamie.Wong@VSA.EDU', ''],
    ]),
    grid('TICKET_MESSAGES', ['MessageId', 'TicketId', 'AuthorEmail', 'AuthorRole', 'Body', 'CreatedAt'], [
      ['m1', 't1', 'Jamie.Wong@VSA.EDU', 'student', 'Is this too broad?', '2026-10-06T00:00:00.000Z'],
    ]),
    grid('AUDIT_LOGS', ['Timestamp', 'User', 'Action', 'Payload'], [
      ['2026-10-06T00:00:00.000Z', 'Jamie.Wong@VSA.EDU', 'LOGIN_SUCCESS', '{}'],
      ['2026-10-06T00:01:00.000Z', 'Jamie.Wong@VSA.EDU', 'VIEW_STUDENT_HOME', '{}'],
    ]),
    grid('Notes', ['Hello'], [['there']]),
  ]);

  assert.equal(plan.docs.staffUsers[0].id, 'alex.chen@vsa.edu');
  assert.equal(plan.docs.staffUsers[0].data.isCoordinator, true);
  assert.equal(plan.docs.cohorts[0].data.FolderPrefix, 'EE ');
  assert.equal(plan.members[0].id, 'jamie.wong@vsa.edu');
  assert.equal(plan.members[0].data.Anchor_Date, '2026-12-15');
  assert.equal(plan.members[0].data.supervisorId, 'alex.chen@vsa.edu');
  assert.equal(plan.docs.milestoneTemplates[0].data.position, 1);
  const response = plan.docs.formResponses[0];
  assert.equal(response.id, 'm1__jamie.wong%40vsa.edu');
  assert.equal(response.data.choice1, 'English');
  assert.equal(response.data.due, '2026-09-26');
  assert.equal(response.data.MilestoneId, 'm1');
  assert.equal(plan.docs.tickets[0].data.Shared, '');
  assert.equal(plan.messages[0].ticketId, 't1');
  assert.equal(plan.messages[0].data.AuthorEmail, 'jamie.wong@vsa.edu');
  assert.equal(plan.audits.length, 2);
  assert.equal(plan.docs.studentUsers, undefined);
  assert.ok(plan.warnings.some((warning) => warning.includes('Notes')));
});

test('content pages become resources when that resource id is new', () => {
  const plan = planSheetImport([
    grid('RESOURCES', ['Resource ID', 'Title', 'Published'], [
      ['guide', 'Already there', true],
    ]),
    grid('CONTENT_PAGES', ['Page ID', 'Title', 'Audience', 'Published', 'Sort Order', 'Slug', 'Body'], [
      ['guide', 'Ignored', 'student', true, 1, 'guide', 'nope'],
      ['words', 'Word limit', 'student', true, 2, 'words', '<p>4,000 words</p>'],
    ]),
  ]);
  const ids = plan.docs.resources.map((doc) => doc.id).sort();
  assert.deepEqual(ids, ['guide', 'words']);
  const words = plan.docs.resources.find((doc) => doc.id === 'words');
  assert.equal(words?.data['Body Format'], 'html');
  assert.equal(words?.data.Category, 'Guide');
});

test('a roster sheet without a cohort registry row still creates the cohort', () => {
  const plan = planSheetImport([
    grid('COHORT: 2027', ['StudentId', 'Display Name', 'Student ID', 'Student Email', 'Year Group'], [
      ['student@vsa.edu', 'Sam Lee', '20270001', 'student@vsa.edu', 12],
    ]),
  ]);
  assert.equal(plan.docs.cohorts[0].id, '2027');
  assert.equal(plan.docs.cohorts[0].data.Status, 'Active');
  assert.ok(plan.warnings.some((warning) => warning.includes('2027')));
});
