let closeMemberEditor = function() {};

export function registerMemberEditorCloser(fn) {
  closeMemberEditor = fn;
}

export function closeOpenMemberEditor() {
  closeMemberEditor();
}

export function hideListJourneyTip() {
  const tip = document.getElementById('list-journey-tip');
  if (tip) tip.hidden = true;
}
