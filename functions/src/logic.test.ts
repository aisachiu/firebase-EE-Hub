import assert from 'node:assert/strict';
import test from 'node:test';
import { lintFormSource, normalizeFormFields, validateFormAnswers, formWritesClosed } from './formsPure';
import { canCompleteMilestone, HubUser } from './permissions';
import { validatePhasePrerequisites } from './phaseRules';
import { assigneeForRoute, staffCanSeeTicket, studentCanSeeTicket, TicketShape } from './ticketsPure';

const student: HubUser = { email: 'student@vsa.example.edu', displayName: 'Jamie', role: 'student' };
const supervisor: HubUser = {
  email: 'supervisor@vsa.example.edu', displayName: 'Priya', role: 'staff',
  permissions: { isStaff: true, isSupervisor: true, isLead: false, isCoordinator: false, isAdmin: false, canAdmin: false },
};
const lead: HubUser = {
  email: 'lead@vsa.example.edu', displayName: 'Lead', role: 'staff',
  permissions: { isStaff: true, isSupervisor: false, isLead: true, isCoordinator: false, isAdmin: false, canAdmin: false },
};
const coordinator: HubUser = {
  email: 'coordinator@vsa.example.edu', displayName: 'Alex', role: 'staff',
  permissions: { isStaff: true, isSupervisor: false, isLead: false, isCoordinator: true, isAdmin: true, canAdmin: true },
};

test('phase prerequisites reject a cycle and a missing phase', () => {
  const chain = [
    { phaseId: 'topic', prerequisitePhaseId: '' },
    { phaseId: 'research', prerequisitePhaseId: 'topic' },
  ];
  assert.throws(() => validatePhasePrerequisites(chain, 'topic', 'topic'), /depend on itself/);
  assert.throws(() => validatePhasePrerequisites(chain, 'writing', 'missing'), /does not exist/);
  assert.throws(() => validatePhasePrerequisites(chain, 'topic', 'research'), /cycle/);
  assert.doesNotThrow(() => validatePhasePrerequisites(chain, 'writing', 'research'));
});

test('milestone permissions follow owner and role', () => {
  assert.equal(canCompleteMilestone(student, student.email, 'student', 'form', null), true);
  assert.equal(canCompleteMilestone(student, 'other@vsa.example.edu', 'student', 'form', null), false);
  assert.equal(canCompleteMilestone(supervisor, student.email, 'supervisor', 'approval', { supervisorId: supervisor.email }), true);
  assert.equal(canCompleteMilestone(supervisor, student.email, 'supervisor', 'approval', { supervisorId: 'other@vsa.example.edu' }), false);
  assert.equal(canCompleteMilestone(lead, student.email, 'lead', 'approval', null), true);
  assert.equal(canCompleteMilestone(lead, student.email, 'coordinator', 'meeting', null), false);
  assert.equal(canCompleteMilestone(coordinator, student.email, 'student', 'upload', null), true);
});

test('form answers enforce required fields, choices, and script limits', () => {
  const fields = normalizeFormFields([
    { name: 'subjects', label: 'Subjects', type: 'checks', required: true, options: ['English', 'History'], maxSelections: 1 },
    { name: 'note', label: 'Note', type: 'textarea', required: true, maxLength: 20 },
  ]);
  assert.throws(() => validateFormAnswers(fields, { subjects: ['English', 'History'], note: 'ok' }, true), /at most 1/);
  assert.throws(() => validateFormAnswers(fields, { subjects: ['Art'], note: 'ok' }, true), /not available/);
  assert.throws(() => validateFormAnswers(fields, { subjects: 'English', note: '' }, true), /Note is required/);
  const saved = validateFormAnswers(fields, { subjects: 'English', note: 'A tight note' }, true);
  assert.equal(saved.subjects, 'English');
  assert.throws(() => lintFormSource('<p>ok</p>', 'eval("no")'), /EEForm only/);
  assert.throws(() => lintFormSource('<script>bad</script>', ''), /JavaScript panel/);
});

test('a date-only form closes on the next local day and stays open without a due date', () => {
  assert.equal(formWritesClosed('', new Date('2026-10-06T12:00:00Z'), 'UTC'), false);
  assert.equal(formWritesClosed('2026-10-05', new Date('2026-10-06T00:00:00Z'), 'UTC'), true);
  assert.equal(formWritesClosed('2026-10-06', new Date('2026-10-06T12:00:00Z'), 'UTC'), false);
});

test('ticket routing shows shared messages to the right queue', () => {
  const ticket: TicketShape = {
    studentId: student.email,
    category: 'Ethics',
    route: 'coordinator',
    assignee: '',
    shared: true,
  };
  assert.equal(studentCanSeeTicket(student.email, ticket), true);
  assert.equal(studentCanSeeTicket(supervisor.email, ticket), false);
  assert.equal(staffCanSeeTicket(coordinator, 'coordinator', ticket, null), true);
  assert.equal(staffCanSeeTicket(supervisor, 'supervisor', ticket, { supervisorId: supervisor.email }), false);
  const supervisorTicket: TicketShape = { ...ticket, route: 'supervisor', category: 'Citations', assignee: supervisor.email };
  assert.equal(staffCanSeeTicket(supervisor, 'supervisor', supervisorTicket, { supervisorId: 'other@vsa.example.edu' }), true);
  const note: TicketShape = { ...ticket, category: 'Note', shared: false, assignee: supervisor.email };
  assert.equal(studentCanSeeTicket(student.email, note), false);
  assert.equal(staffCanSeeTicket(supervisor, 'supervisor', note, { supervisorId: supervisor.email }), false);
  assert.equal(assigneeForRoute('supervisor', { supervisorId: supervisor.email }), supervisor.email);
  assert.equal(assigneeForRoute('coordinator', { supervisorId: supervisor.email }), '');
});
