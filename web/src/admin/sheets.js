import { sheetChoiceModels } from '../../../functions/src/collectionsRegistry.ts';
import { callServer } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml, safeUrl } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { renderSheetIngestPreview } from '../shared/sheetPreview.js';

export function renderSheetSync(target) {
  target.innerHTML = `<section class="editor"><h2>Sheets</h2>${loadingLine('Loading collections...')}</section>`;
  callServer('listSheetCollections').then(function(result) {
    const counts = {};
    (result.collections || []).forEach(function(item) { counts[item.id] = item.count; });
    const visible = sheetChoiceModels(counts);
    const records = visible.filter(function(item) { return item.group === 'records'; });
    const operational = visible.filter(function(item) { return item.group === 'operational'; });
    const choice = function(item) {
      return `<label class="check-option"><input type="checkbox" data-sheet-entity="${escapeHtml(item.id)}" ${item.recommended ? 'checked' : ''}><span>${escapeHtml(item.label)} <span class="muted">${escapeHtml(item.sheet)} · ${escapeHtml(String(item.count))}${item.exportOnly ? ' · export only' : ''}</span></span></label>`;
    };
    target.innerHTML = `<section class="editor">
      <h2>Sheets</h2>
      <p class="doc-hint">Export the collections you choose into a Google Sheet, edit it, then ingest it back. The sheet is created in the connected Google account${result.driveActor ? ` (${escapeHtml(result.driveActor)})` : ''}. Phases, milestones, cohorts, and student lists start selected. A missing tab is left unchanged. Rows you delete in a selected tab are removed from the hub after you preview and confirm. Audit logs can be exported and are not written back. Email logs and word-count samples stay in the hub.</p>
      <div class="toolbar"><button class="button secondary" id="sheet-recommended" type="button">Records to edit</button><button class="button secondary" id="sheet-all" type="button">All collections</button><button class="button secondary" id="sheet-none" type="button">Clear</button></div>
      <h3>Records</h3>
      <div class="sheet-choices">${records.map(choice).join('')}</div>
      <h3>Operational records</h3>
      <p class="doc-hint">Replacing these removes live tasks, messages, or answers that are not in the sheet.</p>
      <div class="sheet-choices">${operational.map(choice).join('')}</div>
      <div class="toolbar"><button class="button" id="sheet-export" type="button">Export selected</button></div>
      <p id="sheet-export-result"></p>
      <label class="field" for="sheet-url">Spreadsheet link</label>
      <input id="sheet-url" placeholder="https://docs.google.com/spreadsheets/d/...">
      <label class="check-option"><input type="checkbox" id="sheet-confirm"><span>Remove hub rows that are not in the selected tabs</span></label>
      <div class="toolbar"><button class="button secondary" id="sheet-preview" type="button">Preview ingest</button><button class="button" id="sheet-apply" type="button" disabled>Ingest into the hub</button></div>
      <div id="sheet-preview-result"></div>
    </section>`;
    const boxes = function() { return Array.from(target.querySelectorAll('[data-sheet-entity]')); };
    const selected = function() { return boxes().filter(function(box) { return box.checked; }).map(function(box) { return box.getAttribute('data-sheet-entity'); }); };
    const clearPreview = function() {
      const apply = document.getElementById('sheet-apply');
      if (apply) apply.disabled = true;
      const preview = document.getElementById('sheet-preview-result');
      if (preview) preview.innerHTML = '';
    };
    document.getElementById('sheet-recommended').addEventListener('click', function() {
      boxes().forEach(function(box) {
        const item = visible.find(function(entry) { return entry.id === box.getAttribute('data-sheet-entity'); });
        box.checked = !!(item && item.recommended);
      });
      clearPreview();
    });
    document.getElementById('sheet-all').addEventListener('click', function() {
      boxes().forEach(function(box) { box.checked = true; });
      clearPreview();
    });
    document.getElementById('sheet-none').addEventListener('click', function() {
      boxes().forEach(function(box) { box.checked = false; });
      clearPreview();
    });
    boxes().forEach(function(box) { box.addEventListener('change', clearPreview); });
    document.getElementById('sheet-url').addEventListener('input', clearPreview);
    document.getElementById('sheet-export').addEventListener('click', function() {
      const entities = selected();
      if (!entities.length) { showError(new Error('Choose at least one collection.')); return; }
      callServer('exportSheetCollections', entities).then(function(exported) {
        const url = safeUrl(exported.url);
        const share = exported.shared ? 'You can edit it.' : `It is owned by ${exported.owner}. ${exported.shareProblem || 'Sharing did not complete.'}`;
        document.getElementById('sheet-export-result').innerHTML = url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(exported.title || 'Open spreadsheet')}</a> <span class="muted">${escapeHtml(share)}</span>`
          : `<span class="muted">${escapeHtml(share)}</span>`;
        if (url) document.getElementById('sheet-url').value = url;
      }).catch(showError);
    });
    document.getElementById('sheet-preview').addEventListener('click', function() {
      const entities = selected().filter(function(id) {
        const item = visible.find(function(entry) { return entry.id === id; });
        return item && !item.exportOnly;
      });
      const source = document.getElementById('sheet-url').value;
      if (!entities.length) { showError(new Error('Choose at least one collection to ingest.')); return; }
      callServer('previewSheetIngest', { url: source }, entities).then(function(preview) {
        document.getElementById('sheet-preview-result').innerHTML = renderSheetIngestPreview({
          summaryColumns: ['Collection', 'Rows in the sheet', 'Rows in the hub', 'Rows removed'],
          summaryRows: preview.tables.map(function(table) {
            return [table.label, table.incoming, table.existing, table.removing];
          }),
          warnings: preview.warnings,
        });
        document.getElementById('sheet-apply').disabled = false;
      }).catch(showError);
    });
    document.getElementById('sheet-apply').addEventListener('click', function() {
      const entities = selected().filter(function(id) {
        const item = visible.find(function(entry) { return entry.id === id; });
        return item && !item.exportOnly;
      });
      const source = document.getElementById('sheet-url').value;
      if (document.getElementById('sheet-confirm').checked !== true) { showError(new Error('Confirm that rows missing from the selected tabs will be removed from the hub.')); return; }
      callServer('applySheetIngest', { url: source }, entities, true).then(function(preview) {
        const labels = preview.tables.map(function(table) { return table.label; }).join(', ');
        document.getElementById('sheet-apply').disabled = true;
        showSuccess(`Updated ${labels} from the spreadsheet.`);
        renderSheetSync(target);
      }).catch(showError);
    });
  }).catch(showError);
}
