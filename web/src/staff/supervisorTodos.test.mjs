import assert from 'node:assert/strict';
import test from 'node:test';
import { state } from '../shared/state.js';
import { rememberSupervisorTodoView, supervisorTodoEntries, supervisorTodoList } from './supervisorTodos.js';
import { supervisorTodoStudentGroups, supervisorTodosByDueDate } from './supervisorTodoViews.js';

const home = {
  viewAs: 'supervisor',
  supervisorMilestoneTodos: [
    { studentEmail: 'zoe@school.edu', studentName: 'Zoe Adams', title: 'Final meeting', due: '2026-12-01', next: false },
    { studentEmail: 'zoe@school.edu', studentName: 'Zoe Adams', title: 'Supervisor approval', due: '2026-11-01', next: true },
    { studentEmail: 'amy@school.edu', studentName: 'Amy Chen', title: 'Viva', due: '', next: true },
    { studentEmail: 'ben@school.edu', studentName: 'Ben Ortiz', title: 'Check draft', due: '2020-01-15', next: true },
    { studentEmail: 'amy@school.edu', studentName: 'Amy Chen', title: 'Later note', due: '2026-12-20', next: false },
    { studentEmail: 'cara@school.edu', studentName: 'Cara Ng', title: 'Intro chat', due: '', next: true },
    { studentEmail: 'liam@school.edu', studentName: 'Liam Park', title: 'Intro chat', due: '', next: true },
    { studentEmail: 'tag@school.edu', studentName: '<Zoe>', title: 'Unsafe name is escaped', due: '2099-01-01', next: false },
  ],
  supervisorTodos: [
    { todoId: 'call', title: 'Call the office', note: 'Soon', due: '2026-09-01', status: 'Pending' },
    { todoId: 'file', title: 'File the form', due: '', status: 'Pending' },
    { todoId: 'done', title: 'Done item', due: '2020-01-01', status: 'Completed' },
  ],
};

function titles(entries) {
  return entries.map(function(entry) { return entry.title; });
}

test('open supervisor to-dos still list added items, then next milestones, then later ones', () => {
  assert.deepEqual(titles(supervisorTodoEntries(home)), [
    'Call the office',
    'File the form',
    'Check draft',
    'Supervisor approval',
    'Viva',
    'Intro chat',
    'Intro chat',
    'Final meeting',
    'Later note',
    'Unsafe name is escaped',
  ]);
});

test('by due date lists every open item earliest first, with undated items last', () => {
  state.supervisorTodoView = 'due';
  const ordered = titles(supervisorTodosByDueDate(supervisorTodoEntries(home)));
  assert.deepEqual(ordered, [
    'Check draft',
    'Call the office',
    'Supervisor approval',
    'Final meeting',
    'Later note',
    'Unsafe name is escaped',
    'Viva',
    'Intro chat',
    'File the form',
    'Intro chat',
  ]);
  const html = supervisorTodoList(home);
  assert.match(html, /aria-label="Supervisor to-do view"/);
  assert.match(html, /data-supervisor-todo-view="due" aria-pressed="true"/);
  assert.match(html, /data-supervisor-todo-view="student" aria-pressed="false"/);
  assert.match(html, />By due date</);
  assert.match(html, />Group by student</);
  assert.ok(html.indexOf('Check draft') < html.indexOf('Call the office'));
  assert.ok(html.indexOf('Call the office') < html.indexOf('Supervisor approval'));
  assert.ok(html.indexOf('Later note') < html.indexOf('File the form'));
  assert.match(html, /data-complete-supervisor-todo="call"/);
  assert.equal(html.includes('Done item'), false);
  assert.match(html, /class="todo-open is-next is-overdue" data-open-student="ben@school.edu"/);
  assert.match(html, /class="todo-open" data-open-student="tag@school.edu"/);
  assert.equal(html.includes('&lt;Zoe&gt;'), true);
  const cara = html.indexOf('data-open-student="cara@school.edu"');
  const file = html.indexOf('data-complete-supervisor-todo="file"');
  const liam = html.indexOf('data-open-student="liam@school.edu"');
  assert.ok(cara < file && file < liam);
});

test('group by student orders groups by the earliest due date, then display name', () => {
  const groups = supervisorTodoStudentGroups(supervisorTodoEntries(home));
  assert.deepEqual(groups.map(function(group) { return [group.name, group.urgency, titles(group.items)]; }), [
    ['Ben Ortiz', '2020-01-15', ['Check draft']],
    ['Added to-dos', '2026-09-01', ['Call the office', 'File the form']],
    ['Zoe Adams', '2026-11-01', ['Supervisor approval', 'Final meeting']],
    ['Amy Chen', '2026-12-20', ['Later note', 'Viva']],
    ['<Zoe>', '2099-01-01', ['Unsafe name is escaped']],
    ['Cara Ng', '9999-99-99', ['Intro chat']],
    ['Liam Park', '9999-99-99', ['Intro chat']],
  ]);
});

test('students with the same earliest due date fall back to display name', () => {
  const groups = supervisorTodoStudentGroups([
    { kind: 'milestone', studentEmail: 'bea@school.edu', studentName: 'Bea Cole', title: 'Meeting', due: '2026-10-05' },
    { kind: 'milestone', studentEmail: 'ada@school.edu', studentName: 'Ada Cole', title: 'Meeting', due: '2026-10-05' },
    { kind: 'milestone', studentEmail: 'ada@school.edu', studentName: 'Ada Cole', title: 'Earlier task', due: '2026-10-05' },
    { kind: 'milestone', studentEmail: 'no-date@school.edu', studentName: 'Nora Dale', title: 'Chat', due: '' },
    { kind: 'milestone', studentEmail: 'also@school.edu', studentName: 'Mina Dale', title: 'Chat', due: '' },
  ]);
  assert.deepEqual(groups.map(function(group) { return group.name; }), ['Ada Cole', 'Bea Cole', 'Mina Dale', 'Nora Dale']);
  assert.deepEqual(titles(groups[0].items), ['Earlier task', 'Meeting']);
});

test('the supervisor list renders grouped students and keeps added to-dos actionable', () => {
  rememberSupervisorTodoView('student');
  const html = supervisorTodoList(home);
  assert.match(html, /data-supervisor-todo-view="student" aria-pressed="true"/);
  assert.match(html, /data-supervisor-todo-view="due" aria-pressed="false"/);
  const ben = html.indexOf('>Ben Ortiz<');
  const added = html.indexOf('>Added to-dos<');
  const zoe = html.indexOf('>Zoe Adams<');
  const amy = html.indexOf('>Amy Chen<');
  const tagged = html.indexOf('>&lt;Zoe&gt;<');
  const cara = html.indexOf('>Cara Ng<');
  const liam = html.indexOf('>Liam Park<');
  assert.ok(ben >= 0 && ben < added && added < zoe && zoe < amy && amy < tagged && tagged < cara && cara < liam);
  const approval = html.indexOf('>Supervisor approval<');
  const finalMeeting = html.indexOf('>Final meeting<');
  assert.ok(zoe < approval && approval < finalMeeting && finalMeeting < amy);
  assert.match(html, /data-open-student="ben@school.edu"/);
  assert.match(html, /data-complete-supervisor-todo="file"/);
  assert.equal(html.includes('Done item'), false);
  rememberSupervisorTodoView('due');
});

test('other staff views do not render the supervisor to-do toggle', () => {
  assert.equal(supervisorTodoList({ viewAs: 'staff', supervisorMilestoneTodos: home.supervisorMilestoneTodos }), '');
  assert.equal(supervisorTodoList(null), '');
});

test('an empty supervisor list still offers both views', () => {
  state.supervisorTodoView = 'due';
  const html = supervisorTodoList({ viewAs: 'supervisor', supervisorMilestoneTodos: [], supervisorTodos: [] });
  assert.match(html, /By due date/);
  assert.match(html, /Group by student/);
  assert.match(html, /Nothing is waiting on you/);
});
