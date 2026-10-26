import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECTIONS } from './schema';
import {
  canonicalStudentEmail,
  canonicalStudentNumber,
  STUDENT_EMAIL_FIELD,
  STUDENT_NUMBER_FIELD,
  syncStudentUserFromMember,
  writeStudentIdentifiers,
} from './studentIdentity';
import { Store } from './store';
import { Doc } from './util';

test('Student Number and Student Email stay distinct from StudentId', () => {
  const legacy = {
    StudentId: 'hub.login@vsa.example.edu',
    'Student ID': '20260001',
    studentEmail: 'jamie.mail@vsa.example.edu',
  };
  assert.equal(canonicalStudentNumber(legacy), '20260001');
  assert.equal(canonicalStudentEmail(legacy), 'jamie.mail@vsa.example.edu');
  assert.equal(canonicalStudentEmail({ StudentId: 'hub.login@vsa.example.edu' }), '');

  const stored = writeStudentIdentifiers({ ...legacy });
  assert.equal(stored[STUDENT_NUMBER_FIELD], '20260001');
  assert.equal(stored[STUDENT_EMAIL_FIELD], 'jamie.mail@vsa.example.edu');
  assert.equal(stored['Student ID'], undefined);
  assert.equal(stored.studentEmail, undefined);
  assert.equal(stored.StudentId, 'hub.login@vsa.example.edu');

  const explicitBlank = writeStudentIdentifiers({
    StudentId: 'hub.login@vsa.example.edu',
    'Student Email': '',
    studentEmail: 'jamie.mail@vsa.example.edu',
    'Student Number': '20260001',
  });
  assert.equal(explicitBlank[STUDENT_EMAIL_FIELD], undefined);
  assert.equal(explicitBlank.studentEmail, undefined);
});

test('saving a cohort member copies Student Number and Student Email onto the student user', async () => {
  const docs = new Map<string, Doc>();
  const store = {
    async get(_name: string, id: string) {
      return docs.has(id) ? { ...docs.get(id) } : null;
    },
    async set(_name: string, id: string, data: Doc) {
      docs.set(id, { ...data });
    },
  };
  const login = 'hub.login@vsa.example.edu';
  docs.set(login, {
    StudentId: login,
    DisplayName: 'Jamie Wong',
    studentEmail: login,
  });
  const updated = await syncStudentUserFromMember(store as unknown as Store, {
    StudentId: login,
    'Student Number': '20260001',
    'Student Email': 'jamie.mail@vsa.example.edu',
  });
  assert.equal(updated, true);
  const user = docs.get(login);
  assert.equal(user?.[STUDENT_NUMBER_FIELD], '20260001');
  assert.equal(user?.[STUDENT_EMAIL_FIELD], 'jamie.mail@vsa.example.edu');
  assert.equal(user?.studentEmail, undefined);
  assert.equal(user?.StudentId, login);
  assert.equal(await syncStudentUserFromMember(store as unknown as Store, {
    StudentId: 'missing@vsa.example.edu',
    'Student Number': '20260002',
    'Student Email': 'missing.mail@vsa.example.edu',
  }), false);
  assert.equal(docs.has('missing@vsa.example.edu'), false);
  assert.equal(COLLECTIONS.studentUsers, 'studentUsers');
});
