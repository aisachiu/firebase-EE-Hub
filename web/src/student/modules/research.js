import { callServer } from '../../shared/api.js';
import { escapeHtml, safeUrl } from '../../shared/html.js';
import { loadingLine } from '../../shared/loading.js';
import { renderResourceCard } from '../../shared/resources.js';
import { state } from '../../shared/state.js';

export const id = 'research';

export function render(home, context) {
  const compact = context && context.slot === 'compact';
  const lede = compact
    ? '<p class="muted">Published guides for your EE. Open a title, or use Resources for the full cards.</p>'
    : '<p class="lede">Guidance and reference material published for your EE. Resources in the header is the full library.</p>';
  return `<div id="research-support"><h2>Research support</h2>${lede}<div data-research-host>${loadingLine('Loading resources...')}</div></div>`;
}

export function mount(host, home, context) {
  const target = host.querySelector('[data-research-host]') || host;
  const compact = !!(context && context.slot === 'compact');
  callServer('getContentHub').then(function(content) {
    if (!target.isConnected) return;
    const resources = (content && content.resources) || [];
    if (!resources.length) {
      target.innerHTML = '<div class="empty">Resources will appear here when published.</div>';
    } else if (compact) {
      target.innerHTML = `<div class="resource-grid">${resources.map(renderCompactResource).join('')}</div>`;
    } else {
      target.innerHTML = `<div class="resource-grid">${resources.map(renderResourceCard).join('')}</div>`;
    }
    if (state.studentFocus === 'research') {
      const marker = document.getElementById('research-support');
      if (marker && marker.scrollIntoView) marker.scrollIntoView({ block: 'start' });
    }
  }).catch(function(error) {
    if (!target.isConnected) return;
    target.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
  });
}

function renderCompactResource(resource) {
  const url = safeUrl(resource.URL);
  const title = escapeHtml(resource.Title || 'Untitled resource');
  const category = escapeHtml(resource.Category || 'Resource');
  const link = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<strong>${title}</strong>`;
  return `<article class="resource"><p class="eyebrow">${category}</p><h3>${link}</h3></article>`;
}
