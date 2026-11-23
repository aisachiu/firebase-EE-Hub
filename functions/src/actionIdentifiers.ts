import { Doc, normalizeEmail, text } from './util';

export function creatorKind(record: Doc): string {
  const value = text(record.CreatorType || record.creatorType).toLowerCase();
  if (value === 'system') return 'System';
  if (value === 'student') return 'Student';
  if (value === 'supervisor') return 'Supervisor';
  return text(record.CreatorType || record.creatorType);
}

export function actionTemplateId(record: Doc): string {
  return text(record.TemplateId || record.templateId || record.MilestoneId || record.milestoneId);
}

export function actionStudentId(record: Doc): string {
  return normalizeEmail(record.StudentId || record.studentId);
}
