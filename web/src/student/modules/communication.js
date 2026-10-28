import { callServer } from '../../shared/api.js';
import { rememberMessageDesk } from '../../shared/desk.js';
import { showError } from '../../shared/feedback.js';
import { escapeHtml } from '../../shared/html.js';
import { loadingLine } from '../../shared/loading.js';
import { state } from '../../shared/state.js';
import { paintStudentMessages, syncStudentUnread } from '../help.js';

export const id = 'communication';

export function render(home, context) {
  if (home && home.staffView) {
    return `<h2>Messages</h2><p class="muted">This student's messages stay on your Messages tab. This preview shows the supervisor, not the student's inbox.</p>`;
  }
  const compact = context && context.slot === 'compact';
  return `<div data-communication-host>${compact ? '<p class="muted">Loading messages...</p>' : loadingLine('Loading messages...')}</div>`;
}

export function mount(host, home, context) {
  if (home && home.staffView) return;
  const target = host.querySelector('[data-communication-host]') || host;
  const compact = context && context.slot === 'compact';
  const hub = state.messageDesks.student;
  if (hub) {
    syncStudentUnread(hub);
    paintStudentMessages(hub, target, { compact: compact });
    return;
  }
  callServer('getTicketHub').then(function(loaded) {
    if (!target.isConnected) return;
    rememberMessageDesk(loaded, 'student');
    syncStudentUnread(loaded);
    if (!communicationStillOpen()) return;
    paintStudentMessages(loaded, target, { compact: compact });
  }).catch(function(error) {
    if (!target.isConnected) return;
    target.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
    showError(error);
  });
}

function communicationStillOpen() {
  if (state.user && state.user.role === 'student') return state.section === 'supervisor' || state.section === 'document';
  return state.staffPreviewView === 'supervisor' || state.staffPreviewView === 'document';
}
