export function staffStudentDrawersHtml(options) {
  const journeyOpen = !!(options && options.journeyOpen);
  const notesOpen = !!(options && options.notesOpen);
  return `<div id="side-drawers" class="side-drawers">
    <aside id="journey-panel" class="journey-panel${journeyOpen ? ' open' : ''}" aria-label="Student Journey">
      <button type="button" class="journey-peek" id="journey-peek" aria-expanded="${journeyOpen ? 'true' : 'false'}" aria-controls="journey-drawer">Student Journey</button>
      <div class="journey-drawer" id="journey-drawer"${journeyOpen ? '' : ' inert'} aria-hidden="${journeyOpen ? 'false' : 'true'}">
        <div class="journey-panel-bar"><strong>Student Journey</strong><button type="button" id="journey-close">Close</button></div>
        <div id="journey-body" class="journey-scroll"></div>
      </div>
    </aside>
    <aside id="notes-panel" class="notes-panel${notesOpen ? ' open' : ''}" aria-label="Notes for this student">
      <button type="button" class="notes-peek" id="notes-peek" aria-expanded="${notesOpen ? 'true' : 'false'}" aria-controls="notes-drawer">Notes</button>
      <div class="notes-drawer" id="notes-drawer"${notesOpen ? '' : ' inert'} aria-hidden="${notesOpen ? 'false' : 'true'}">
        <div class="journey-panel-bar"><strong>Notes</strong><button type="button" id="notes-close">Close</button></div>
        <div id="notes-body" class="notes-scroll"></div>
      </div>
    </aside>
  </div>`;
}
