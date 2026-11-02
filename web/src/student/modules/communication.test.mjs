import assert from 'node:assert/strict';
import test from 'node:test';

test('supervisors and coordinators get a compose box on the student chat page', async () => {
  globalThis.window = {
    localStorage: { getItem() { return null; }, setItem() {} },
    matchMedia() { return { matches: false }; },
    location: { pathname: '/my-ee', search: '', hash: '' },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
  };
  globalThis.document = {
    title: '',
    getElementById() { return null; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const communication = await import('./communication.js');
  const supervisor = {
    staffView: true,
    viewAs: 'supervisor',
    canSendChat: true,
    displayName: 'Jamie Wong',
    email: 'jamie@vsa.example.edu',
  };
  const coordinator = { ...supervisor, viewAs: 'coordinator' };
  const browse = { ...supervisor, viewAs: 'staff', canSendChat: false };
  const blockedSupervisor = { ...supervisor, canSendChat: false };
  const student = { displayName: 'Jamie Wong', links: { doc: 'https://docs.google.com/document/d/abc123/edit' } };

  assert.equal(communication.staffChatComposeEnabled(supervisor), true);
  assert.equal(communication.staffChatComposeEnabled(coordinator), true);
  assert.equal(communication.staffChatComposeEnabled(browse), false);
  assert.equal(communication.staffChatComposeEnabled(blockedSupervisor), false);
  assert.equal(communication.staffChatComposeEnabled(student), false);

  assert.match(communication.render(supervisor, { thread: true }), /data-communication-host/);
  assert.match(communication.render(coordinator, { thread: true }), /data-communication-host/);
  assert.match(communication.render(browse, { thread: true }), /data-communication-host/);
  assert.match(communication.render(browse, {}), /does not open their inbox/);
  assert.match(communication.render(blockedSupervisor, { thread: true }), /data-communication-host/);
  assert.match(communication.render(student, { thread: true }), /data-communication-host/);
  assert.doesNotMatch(communication.render(student, { thread: true }), /does not open their inbox/);

  const hub = {
    canCompose: true,
    viewerEmail: 'supervisor@vsa.example.edu',
    tickets: [{
      route: 'supervisor',
      category: 'Doc comment',
      messages: [{
        createdAt: '2026-10-01T07:00:00.000Z',
        authorRole: 'staff',
        authorName: 'Ms Sharma',
        quote: 'the river',
        body: 'Tighten this.',
        commentId: 'abc',
      }],
    }, {
      route: 'supervisor',
      messages: [
        { createdAt: '2026-10-01T08:00:00.000Z', authorRole: 'student', authorName: 'Jamie Wong', body: 'Hello' },
        { createdAt: '2026-10-01T09:00:00.000Z', authorRole: 'staff', authorEmail: 'supervisor@vsa.example.edu', authorName: 'Priya Shah', body: 'Hi Jamie' },
      ],
    }],
  };
  const staffHtml = communication.supervisorThreadHtml(hub, { ...supervisor, links: student.links });
  assert.match(staffHtml, /data-chat-form/);
  assert.match(staffHtml, /Message to this student/);
  assert.match(staffHtml, /Message this student/);
  assert.match(staffHtml, /Doc comment/);
  assert.match(staffHtml, /Tighten this/);
  assert.match(staffHtml, /disco=abc/);
  assert.match(staffHtml, /Jamie Wong/);
  assert.match(staffHtml, />You</);
  assert.match(staffHtml, /Hi Jamie/);
  assert.doesNotMatch(staffHtml, /data-chat-help/);
  assert.match(staffHtml, /class="ee-bubble mine"/);

  const studentHtml = communication.supervisorThreadHtml({
    tickets: [{
      route: 'supervisor',
      messages: [
        { createdAt: '2026-10-01T08:00:00.000Z', authorRole: 'student', body: 'Hello' },
        { createdAt: '2026-10-01T09:00:00.000Z', authorRole: 'staff', authorName: 'Priya Shah', body: 'Hi Jamie' },
      ],
    }],
  }, student);
  assert.match(studentHtml, /data-chat-form/);
  assert.match(studentHtml, /Message to your supervisor/);
  assert.match(studentHtml, /Message your supervisor/);
  assert.match(studentHtml, /data-chat-help/);
  assert.match(studentHtml, /Priya Shah/);
  assert.match(studentHtml, /class="ee-bubble mine"/);

  const readOnly = communication.supervisorThreadHtml({ canCompose: false, tickets: [] }, supervisor);
  assert.doesNotMatch(readOnly, /data-chat-form/);
  assert.match(readOnly, /No Doc comments in this chat yet/);
  assert.match(readOnly, /In-app messages stay on your Messages tab/);
  const browseHtml = communication.supervisorThreadHtml({ tickets: [] }, browse);
  assert.doesNotMatch(browseHtml, /data-chat-form/);
});
