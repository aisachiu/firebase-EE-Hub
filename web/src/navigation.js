let render = function() {};

export function setShellRenderer(fn) {
  render = fn;
}

export function renderShell() {
  render();
}

export function paintTabDot(view, count, label) {
  const button = document.querySelector('[data-view="' + view + '"]');
  if (!button) return;
  button.innerHTML = label + (count ? '<span class="dot" aria-label="Unread"></span>' : '');
}
