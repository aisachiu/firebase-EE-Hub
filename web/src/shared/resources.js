import { callServer } from './api.js';
import { showError } from './feedback.js';
import { escapeHtml, safeUrl } from './html.js';
import { loadingLine } from './loading.js';
import { advanceScene } from './scene.js';

export function renderResources() {
  advanceScene();
  const main = document.getElementById('main');
  main.innerHTML = loadingLine('Loading resources...');
  callServer('getContentHub').then(function(content) {
    const resources = content.resources || [];
    main.innerHTML = `<div class="page-head"><div><p class="eyebrow">Extended Essay</p><h1>Resources</h1><p class="lede">Guidance and reference material for your EE.</p></div></div>
      ${resources.length ? `<div class="resource-grid">${resources.map(renderResource).join('')}</div>` : '<div class="empty">Resources will appear here when published.</div>'}`;
  }).catch(showError);
}

export function renderResource(resource) {
  return renderResourceCard(resource);
}

export function renderResourceCard(resource) {
  const url = safeUrl(resource.URL);
  const description = resource.Description ? `<p>${escapeHtml(resource.Description)}</p>` : '';
  const body = renderResourceBody(resource.Body, resource['Body Format']);
  return `<article class="resource"><p class="eyebrow">${escapeHtml(resource.Category || 'Resource')}</p><h3>${escapeHtml(resource.Title || 'Untitled resource')}</h3>${description}${body}${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open resource ↗</a>` : ''}</article>`;
}

export function renderResourceBody(body, format) {
  const text = String(body || '');
  if (!text.trim()) return '';
  const kind = String(format || 'plain').toLowerCase();
  if (kind === 'html') return `<div class="resource-body html">${sanitizeResourceHtml(text)}</div>`;
  if (kind === 'markdown') return `<div class="resource-body markdown">${renderMarkdown(text)}</div>`;
  return `<div class="resource-body plain">${escapeHtml(text)}</div>`;
}

export function sanitizeResourceHtml(value) {
  const template = document.createElement('template');
  template.innerHTML = String(value || '');
  template.content.querySelectorAll('script, iframe, object, embed, link, meta').forEach(function(node) { node.remove(); });
  template.content.querySelectorAll('*').forEach(function(node) {
    Array.from(node.attributes).forEach(function(attr) {
      const name = attr.name.toLowerCase();
      if (name.indexOf('on') === 0 || ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value))) node.removeAttribute(attr.name);
    });
  });
  return template.innerHTML;
}

export function markdownBlock(line) {
  if (/^(#{1,3})\s+\S/.test(line)) return 'heading';
  if (/^[-*]\s+\S/.test(line)) return 'ul';
  if (/^\d+\.\s+\S/.test(line)) return 'ol';
  return '';
}

export function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!String(line || '').trim()) { index++; continue; }
    const kind = markdownBlock(line);
    if (kind === 'heading') {
      const heading = /^(#{1,3})\s+(\S.*)$/.exec(line);
      blocks.push(`<h${heading[1].length}>${renderMarkdownInline(heading[2])}</h${heading[1].length}>`);
      index++;
      continue;
    }
    if (kind === 'ul' || kind === 'ol') {
      const items = [];
      while (index < lines.length && markdownBlock(lines[index]) === kind) {
        items.push(`<li>${renderMarkdownInline(lines[index].replace(kind === 'ul' ? /^[-*]\s+/ : /^\d+\.\s+/, ''))}</li>`);
        index++;
      }
      blocks.push(kind === 'ul' ? `<ul>${items.join('')}</ul>` : `<ol>${items.join('')}</ol>`);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && String(lines[index] || '').trim() && !markdownBlock(lines[index])) {
      paragraph.push(renderMarkdownInline(lines[index]));
      index++;
    }
    if (!paragraph.length) { index++; continue; }
    blocks.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return blocks.join('');
}

export function renderMarkdownInline(raw) {
  const text = String(raw || '');
  const parts = [];
  const code = /`([^`\n]+)`/g;
  let last = 0;
  let match;
  while ((match = code.exec(text))) {
    parts.push(renderMarkdownEmphasis(text.slice(last, match.index)));
    parts.push(`<code>${escapeHtml(match[1])}</code>`);
    last = match.index + match[0].length;
  }
  parts.push(renderMarkdownEmphasis(text.slice(last)));
  return parts.join('');
}

export function renderMarkdownEmphasis(raw) {
  const text = String(raw || '');
  let html = '';
  let index = 0;
  while (index < text.length) {
    if (text.slice(index, index + 2) === '**') {
      const end = text.indexOf('**', index + 2);
      if (end > index + 2) {
        html += '<strong>' + escapeHtml(text.slice(index + 2, end)) + '</strong>';
        index = end + 2;
        continue;
      }
    }
    if (text.charAt(index) === '*') {
      const end = text.indexOf('*', index + 1);
      if (end > index + 1) {
        html += '<em>' + escapeHtml(text.slice(index + 1, end)) + '</em>';
        index = end + 1;
        continue;
      }
    }
    const link = /^\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/.exec(text.slice(index));
    if (link) {
      const safe = safeUrl(link[2]);
      html += safe
        ? '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(link[1]) + '</a>'
        : escapeHtml(link[0]);
      index += link[0].length;
      continue;
    }
    const next = text.slice(index).search(/[*[]/);
    if (next < 0) {
      html += escapeHtml(text.slice(index));
      break;
    }
    if (next === 0) {
      html += escapeHtml(text.charAt(index));
      index += 1;
      continue;
    }
    html += escapeHtml(text.slice(index, index + next));
    index += next;
  }
  return html;
}
