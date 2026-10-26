import { escapeHtml } from './html.js';
import { state } from './state.js';

export function staffActingRoles(user) {
  const permissions = (user && user.permissions) || {};
  const roles = [];
  if (permissions.canAdmin) roles.push(['coordinator', 'Coordinator']);
  if (permissions.isSupervisor) roles.push(['supervisor', 'Supervisor']);
  roles.push(['staff', 'Staff browse']);
  return roles;
}

export function actingAsOptions(user, selected) {
  return staffActingRoles(user).map(function(role) {
    return `<option value="${escapeHtml(role[0])}" ${selected === role[0] ? 'selected' : ''}>${escapeHtml(role[1])}</option>`;
  }).join('');
}

export function syncHeaderCohortSelect() {
  if (typeof document === 'undefined') return;
  const select = document.getElementById('header-cohort');
  if (!select || !state.cohortId) return;
  const hasOption = Array.prototype.some.call(select.options, function(option) { return option.value === state.cohortId; });
  if (hasOption) select.value = state.cohortId;
}
