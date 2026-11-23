import { createHash } from 'node:crypto';
import { Doc, HubError, normalizeEmail, text } from './util';
import { actionStudentId, actionTemplateId, creatorKind } from './actionIdentifiers';

export function milestoneAssignmentScope(items: Doc[], members: Doc[], cohortId: string, milestoneId: string) {
  const memberIdentities = new Map<string, { name: string; studentId: string }>();
  members.forEach((member) => {
    const name = text(member['Display Name']) || text(member.DisplayName);
    const studentId = normalizeEmail(member.StudentId) || normalizeEmail(member['Student Email']);
    [member.StudentId, member['Student Email']].forEach((value) => {
      const email = normalizeEmail(value);
      if (email) memberIdentities.set(email, { name: name || studentId, studentId });
    });
  });
  const assignments: { taskId: string; studentId: string; canonicalStudentId: string; studentName: string; status: string; cohortId: string; creator: string; legacy: boolean; updatedAt: string }[] = [];
  const excluded: { taskId: string; studentId: string; canonicalStudentId: string; studentName: string; status: string; cohortId: string; creator: string; reason: string }[] = [];
  items.forEach((item) => {
    if (actionTemplateId(item) !== milestoneId) return;
    const studentId = actionStudentId(item);
    const taskCohort = text(item.cohortId);
    const belongs = taskCohort === cohortId;
    const ambiguous = !taskCohort && memberIdentities.has(studentId);
    const otherCohort = !!taskCohort && taskCohort !== cohortId && memberIdentities.has(studentId);
    if (!belongs && !otherCohort && !ambiguous) return;
    const taskId = text(item.TaskId);
    if (belongs && !taskId) throw new HubError('A matching action item has no TaskId. Correct it before managing this milestone.');
    const row = {
      taskId,
      studentId,
      canonicalStudentId: memberIdentities.get(studentId)?.studentId || studentId,
      studentName: memberIdentities.get(studentId)?.name || studentId || '(unknown student)',
      status: text(item.Status) || '(no status)',
      cohortId: taskCohort,
      creator: creatorKind(item),
    };
    if (belongs) assignments.push({ ...row, legacy: !taskCohort, updatedAt: text(item.LastUpdated) });
    else excluded.push({ ...row, reason: ambiguous ? 'legacy' : 'other-cohort' });
  });
  const compare = (left: { taskId: string }, right: { taskId: string }) => left.taskId.localeCompare(right.taskId);
  assignments.sort(compare);
  excluded.sort(compare);
  if (new Set(assignments.map((row) => row.taskId)).size !== assignments.length) {
    throw new HubError('Matching action items have duplicate TaskIds. Correct them before managing this milestone.');
  }
  const signature = createHash('sha256').update(JSON.stringify({ cohortId, milestoneId, assignments, excluded })).digest('hex');
  return { assignments, excluded, signature };
}
