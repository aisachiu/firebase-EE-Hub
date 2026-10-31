import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { pageFromSearch, stepEePage } from '../shared/eePage.js';
import { calendarShellHtml, renderMonthHtml } from './modules/calendar.js';
import {
  docCommentHref,
  essayEmbedSrc,
  initialMonthWindow,
  milestoneMarks,
  stripOffset,
  studentViewsForPage,
  threadEntries,
} from './rotary.js';

const home = {
  templates: [
    { milestoneId: 'm1', title: 'Subject confirmed', phase: 'p1' },
    { milestoneId: 'm2', title: 'Research question', phase: 'p2' },
  ],
  phases: [
    { phaseId: 'p1', phaseTitle: 'Start' },
    { phaseId: 'p2', phaseTitle: 'Draft' },
  ],
  actionItems: [
    { CreatorType: 'System', TemplateId: 'm1', Title: 'Subject confirmed', Status: 'Completed', DueDate: '2026-06-15', PhaseId: 'p1' },
    { CreatorType: 'System', TemplateId: 'm2', Title: 'Research question', Status: 'Pending', DueDate: '2026-12-15', PhaseId: 'p2' },
  ],
  links: { doc: 'https://docs.google.com/document/d/abc123/edit' },
};

test('the rotary wraps and the strip offsets keep 3 and 4 the same width', () => {
  assert.equal(stepEePage(4, 1), 0);
  assert.equal(stepEePage(0, -1), 4);
  assert.equal(stripOffset(1, 'strip'), 0);
  assert.equal(stripOffset(2, 'strip'), -2 / 3);
  assert.equal(stripOffset(3, 'strip'), -5 / 3);
  assert.equal(stripOffset(4, 'strip'), 0);
  assert.equal(stripOffset(4, 'alt'), -2 / 3);
  assert.equal(stripOffset(3, 'alt'), 0);
  assert.deepEqual(studentViewsForPage(0), ['document']);
  assert.deepEqual(studentViewsForPage(4), ['document', 'supervisor']);
});

test('milestone months include the next due date and the calendar has no range controls', () => {
  const marks = milestoneMarks(home);
  assert.equal(marks.length, 2);
  assert.equal(marks[1].status, 'current');
  assert.equal(marks[1].date, '2026-12-15');
  assert.equal(marks[1].phase, 2);
  const window = initialMonthWindow(marks, new Date(2026, 9, 31));
  assert.ok(window.start <= (2026 * 12 + 11));
  assert.ok(window.end >= (2026 * 12 + 11));
  const shell = calendarShellHtml();
  const month = renderMonthHtml(2026 * 12 + 11, marks, '2026-12-15');
  assert.match(shell, /Scroll for more months/);
  assert.match(month, /Research question/);
  assert.doesNotMatch(shell + month, /Earlier|Later|<details|Range/);
});

test('doc comments are distinct cards and deep-link with disco', () => {
  const href = docCommentHref(home.links.doc, 'comment-9');
  assert.equal(href, 'https://docs.google.com/document/d/abc123/edit?disco=comment-9');
  assert.equal(essayEmbedSrc(home.links.doc), 'https://docs.google.com/document/d/abc123/edit?embedded=true');
  const entries = threadEntries({
    tickets: [
      {
        route: 'supervisor',
        messages: [
          { createdAt: '2026-10-01T08:00:00.000Z', authorRole: 'staff', authorName: 'Ms Sharma', body: 'See you Friday.' },
          { createdAt: '2026-10-02T08:00:00.000Z', authorRole: 'student', body: 'Thank you.' },
        ],
      },
      {
        route: 'coordinator',
        messages: [{ createdAt: '2026-10-03T08:00:00.000Z', authorRole: 'staff', body: 'Coordinator only.' }],
      },
    ],
  }, {
    links: home.links,
    docComments: [{ at: '2026-10-01T12:00:00.000Z', author: 'Ms Sharma', quote: 'the river', body: 'Tighten this.', commentId: 'abc' }],
  });
  assert.deepEqual(entries.map((item) => item.type), ['chat', 'doc', 'chat']);
  assert.equal(entries[1].href, 'https://docs.google.com/document/d/abc123/edit?disco=abc');
  assert.equal(entries.some((item) => item.body === 'Coordinator only.'), false);
});

test('a page query is optional and invalid pages settle on the document', () => {
  assert.equal(pageFromSearch(''), null);
  assert.equal(pageFromSearch('?page=2'), 2);
  assert.equal(pageFromSearch('?page=9'), 0);
});

test('the stage markup is five panes and the embedded doc is 90vh', async () => {
  globalThis.window = {
    localStorage: { getItem() { return null; }, setItem() {} },
    matchMedia() { return { matches: false }; },
    location: { pathname: '/my-ee', search: '', hash: '' },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
  };
  globalThis.document = { title: '', getElementById() { return null; }, addEventListener() {} };
  const views = await import('./views.js');
  const html = views.studentStageHtml(home, 0, false);
  assert.match(html, /data-ee-pane="doc"/);
  assert.match(html, /data-ee-pane="journey"/);
  assert.match(html, /data-ee-pane="calendar"/);
  assert.match(html, /data-ee-pane="meetings"/);
  assert.match(html, /data-ee-pane="chat"/);
  assert.match(html, /class="gdoc-frame"/);
  assert.match(html, /Working draft/);
  assert.match(html, /View journey/);
  assert.match(html, /id="my-activity"/);
  assert.doesNotMatch(html, /Earlier|Later/);
  const css = fs.readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.gdoc-frame\s*\{[^}]*height:\s*90vh/);
  assert.match(css, /\.ee-stage\.is-mobile\[data-page="0"\] \.gdoc-embed/);
  window.matchMedia = function() { return { matches: true }; };
  const phone = views.studentStageHtml(home, 0, false);
  assert.match(phone, /is-mobile/);
  assert.match(phone, /Open in Google Docs/);
  assert.doesNotMatch(phone, /<iframe/);
});
