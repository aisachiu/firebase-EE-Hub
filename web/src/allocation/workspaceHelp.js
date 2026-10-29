import { WORKSPACE_SHEET_HELP } from '../../../functions/src/workspaceSheetHelp.ts';
import { escapeHtml } from '../shared/html.js';

export function workspaceHelpMarkup(cohortYear) {
  const help = WORKSPACE_SHEET_HELP;
  const year = cohortYear || '2026';
  const row = help.exampleRow;
  const headers = help.exampleHeaders;
  return `<div class="alloc-help">
    <p class="doc-hint">Workspace ingest reads one tab. This cohort uses <code>COHORTDATA: ${escapeHtml(year)}</code>. A colon and the spaces around it are optional.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>What the sheet needs</th></tr></thead>
      <tbody>
        <tr><td>Tab title</td><td><code>${escapeHtml(help.tabPattern)}</code>, for example <code>${escapeHtml(help.tabExample)}</code></td></tr>
        <tr><td>Required column</td><td><code>${escapeHtml(help.requiredColumn)}</code> is ${escapeHtml(help.requiredMeans)}</td></tr>
        <tr><td>Optional flag</td><td>${help.activeHeaders.map(function(header) { return `<code>${escapeHtml(header)}</code>`; }).join(' or ')}</td></tr>
        <tr><td>Choices (JSON)</td><td>Column ${help.choiceHeaders.map(function(header) { return `<code>${escapeHtml(header)}</code>`; }).join(' or ')}. The cell is ${escapeHtml(help.choiceShape)}.</td></tr>
        <tr><td>Choices (columns)</td><td>And/or a header such as ${help.choiceColumnPrefixes.map(function(prefix) { return `<code>${escapeHtml(prefix + 'choice2')}</code>`; }).join(', ')} with a plain text value</td></tr>
        <tr><td>Other columns</td><td>${escapeHtml(help.otherColumns)}</td></tr>
        <tr><td>Subject values</td><td>${escapeHtml(help.subjectValues)}</td></tr>
      </tbody>
    </table></div>
    <p class="alloc-kicker">SubjectChoice JSON</p>
    <pre>${escapeHtml(help.jsonExample)}</pre>
    <p class="alloc-kicker">One-row example</p>
    <div class="table-wrap alloc-example"><table>
      <thead><tr>${headers.map(function(header) { return `<th>${escapeHtml(header)}</th>`; }).join('')}</tr></thead>
      <tbody><tr>${headers.map(function(header) {
        const value = row[header];
        const code = header === 'SubjectChoice';
        return `<td>${code ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value)}</td>`;
      }).join('')}</tr></tbody>
    </table></div>
    <p class="doc-hint">${escapeHtml(help.mappingNote)}</p>
  </div>`;
}
