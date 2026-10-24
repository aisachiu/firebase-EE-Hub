import { escapeHtml } from './html.js';

export function renderSheetIngestPreview(model) {
  const summaryColumns = model.summaryColumns || [];
  const summaryRows = model.summaryRows || [];
  const detailColumns = model.detailColumns || [];
  const detailRows = model.detailRows || [];
  const note = model.note ? `<p class="doc-hint">${escapeHtml(model.note)}</p>` : '';
  const summary = summaryColumns.length ? `<div class="table-wrap"><table class="data"><thead><tr>${summaryColumns.map(function(label) {
    return `<th>${escapeHtml(label)}</th>`;
  }).join('')}</tr></thead><tbody>${summaryRows.length ? summaryRows.map(function(row) {
    return `<tr>${row.map(function(cell) { return `<td>${escapeHtml(cell)}</td>`; }).join('')}</tr>`;
  }).join('') : `<tr><td colspan="${summaryColumns.length}">No rows.</td></tr>`}</tbody></table></div>` : '';
  const capped = detailRows.slice(0, 400);
  const hidden = detailRows.length - capped.length;
  const detailTitle = model.detailTitle ? `<h3>${escapeHtml(model.detailTitle)}</h3>` : '';
  const detail = detailColumns.length ? `${detailTitle}<div class="table-wrap"><table class="data"><thead><tr>${detailColumns.map(function(label) {
    return `<th>${escapeHtml(label)}</th>`;
  }).join('')}</tr></thead><tbody>${capped.length ? capped.map(function(row) {
    return `<tr>${row.map(function(cell) { return `<td>${escapeHtml(cell)}</td>`; }).join('')}</tr>`;
  }).join('') : `<tr><td colspan="${detailColumns.length}">No rows in this sheet.</td></tr>`}</tbody></table></div>${hidden ? `<p class="muted">Showing the first ${capped.length} rows. ${hidden} more are not listed.</p>` : ''}` : '';
  const warnings = (model.warnings || []).map(function(warning) { return `<li>${escapeHtml(warning)}</li>`; }).join('');
  return `<div class="sheet-preview">${note}${summary}${detail}${warnings ? `<ul>${warnings}</ul>` : ''}</div>`;
}
