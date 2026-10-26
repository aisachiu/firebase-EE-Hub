export function commonMilestoneChoices(home, students) {
  if (!students.length) return [];
  const counts = {};
  const titles = {};
  students.forEach(function(student) {
    const seen = {};
    (student.assigned || []).forEach(function(item) {
      const id = item && (item.templateId || item.milestoneId);
      if (!id || seen[id]) return;
      seen[id] = true;
      counts[id] = (counts[id] || 0) + 1;
      if (item.title && !titles[id]) titles[id] = item.title;
    });
  });
  const listed = {};
  const choices = [];
  (home.templates || []).forEach(function(template) {
    const id = template && template.milestoneId;
    if (!id || listed[id]) return;
    listed[id] = true;
    choices.push({ id: id, title: template.title || titles[id] || id });
  });
  Object.keys(counts).forEach(function(id) {
    if (counts[id] === students.length && !listed[id]) choices.push({ id: id, title: titles[id] || id });
  });
  return choices;
}
