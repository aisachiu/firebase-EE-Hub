import { escapeHtml } from './shared/html.js';
import { maintenanceMessage } from './shared/serverSettings.js';

export function maintenancePageHtml(settings, actionsHtml) {
  const message = maintenanceMessage(settings);
  return `<div class="shell maintenance-page"><p class="eyebrow">VSA EE Hub</p><h1>We'll be back soon</h1><p class="lede maintenance-note" role="status">${escapeHtml(message)}</p><p class="muted">Thank you for your patience.</p>${actionsHtml || ''}</div>`;
}
