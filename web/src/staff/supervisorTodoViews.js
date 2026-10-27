import { textCompare } from '../shared/html.js';

const UNDATED = '9999-99-99';

function dueKey(due) {
  return due ? String(due).slice(0, 10) : UNDATED;
}

export function compareSupervisorTodosByDue(left, right) {
  const due = dueKey(left && left.due).localeCompare(dueKey(right && right.due));
  if (due) return due;
  const name = textCompare(left.studentName || left.title, right.studentName || right.title);
  if (name) return name;
  const title = textCompare(left.title, right.title);
  if (title) return title;
  return textCompare(left.todoId || '', right.todoId || '');
}

export function supervisorTodosByDueDate(entries) {
  return (entries || []).slice().sort(compareSupervisorTodosByDue);
}

function groupKey(entry) {
  if (entry && entry.kind !== 'added' && (entry.studentEmail || entry.studentName)) {
    return 'student:' + (entry.studentEmail || entry.studentName);
  }
  return 'added';
}

export function supervisorTodoStudentGroups(entries) {
  const groups = new Map();
  (entries || []).forEach(function(entry) {
    const key = groupKey(entry);
    let group = groups.get(key);
    if (!group) {
      const student = key !== 'added';
      group = {
        key: key,
        kind: student ? 'student' : 'added',
        name: student ? (entry.studentName || entry.studentEmail || 'Student') : 'Added to-dos',
        items: [],
        urgency: UNDATED,
      };
      groups.set(key, group);
    } else if (key !== 'added' && entry.studentName) {
      group.name = entry.studentName;
    }
    group.items.push(entry);
    const urgency = dueKey(entry.due);
    if (urgency < group.urgency) group.urgency = urgency;
  });
  const list = Array.from(groups.values());
  list.forEach(function(group) {
    group.items.sort(compareSupervisorTodosByDue);
  });
  list.sort(function(left, right) {
    const urgent = left.urgency.localeCompare(right.urgency);
    if (urgent) return urgent;
    const name = textCompare(left.name, right.name);
    if (name) return name;
    return textCompare(left.key, right.key);
  });
  return list;
}
