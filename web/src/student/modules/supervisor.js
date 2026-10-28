import { escapeHtml } from '../../shared/html.js';

export const id = 'supervisor';

export function render(home) {
  const email = (home && home.supervisorId) || '';
  const name = (home && home.supervisorName) || '';
  if (!email && !name) {
    return `<h2>Your supervisor</h2><div class="empty"><p>A supervisor has not been assigned yet.</p><p class="muted">When one is assigned, their name and email stay on this view.</p></div>`;
  }
  const shown = name || email;
  const mail = email ? `<p><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>` : '';
  const subject = home && home.subject ? `<p class="muted">Subject · ${escapeHtml(home.subject)}</p>` : '';
  return `<h2>Your supervisor</h2><p class="supervisor-name">${escapeHtml(shown)}</p>${mail}${subject}<p class="muted">Messages to your supervisor are in the section below.</p>`;
}

export function mount() {}
