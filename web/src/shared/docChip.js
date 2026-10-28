import { escapeHtml, safeUrl } from './html.js';

export function docChipMarkup(home) {
  const links = (home && home.links) || {};
  const doc = safeUrl(links.doc);
  const folder = safeUrl(links.folder);
  const docControl = doc
    ? `<a class="doc-chip" href="${escapeHtml(doc)}" target="_blank" rel="noopener noreferrer">Open essay Doc</a>`
    : '<span class="doc-chip is-disabled" aria-disabled="true" title="The essay Doc has not been created yet">Open essay Doc</span>';
  const folderControl = folder
    ? `<a class="doc-chip" href="${escapeHtml(folder)}" target="_blank" rel="noopener noreferrer">Drive folder</a>`
    : '';
  return `<span class="doc-chips" id="doc-chips">${docControl}${folderControl}</span>`;
}

export function paintDocChips(home) {
  const current = document.getElementById('doc-chips');
  if (!current) return;
  const template = document.createElement('template');
  template.innerHTML = docChipMarkup(home);
  const node = template.content.firstElementChild;
  if (node) current.replaceWith(node);
}
