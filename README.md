# Firebase EE Hub

Firebase version of the [VSA Extended Essay hub](https://github.com/aisachiu/GAS-EE-Hub). The screens are the same. Records live in Firestore, sign-in is Firebase Auth, and the Apps Script calls are one Cloud Function named `eeHub`.

Students see My EE, resources, and help. Staff see My Students, messages, and notes. Coordinators and admins also see Admin. Milestone ownership, phase prerequisites, tickets, and milestone forms are enforced in the function. The browser cannot write Firestore directly.

## Local app

Java is required for the Firestore emulator.

```bash
npm install
npm --prefix functions install
npm run build:functions
npm run emulators
```

In another terminal, after the emulators are up:

```bash
npm run seed
npm run dev
```

Open http://127.0.0.1:5173. On the emulator, use a demo account:

| Account | Email |
| --- | --- |
| Student | student@vsa.example.edu |
| Supervisor | supervisor@vsa.example.edu |
| Coordinator | coordinator@vsa.example.edu |

The emulator password for those buttons is `ee-hub-demo`. Google sign-in is the production path: the signed-in email must match a staff or student record.

`npm test` checks phase cycles, milestone permissions, form answers, and ticket routing. `npm run schema` checks field names and that each table has its key. The audit log stays append-only, with no key.

## Deploy

```bash
firebase login
firebase use --add
npm run build
npm run build:functions
firebase deploy
```

Set `EE_TIMEZONE` (default `Asia/Hong_Kong`) on the function. To create and share cohort Drive folders, set `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` to the service account key and share the cohort folder with that account. Without it, the rest of the hub still runs and the Admin Drive panel says sync is not configured.

## Data

Cohorts, members, phases, milestones, users, subjects, resources, FAQs, quotations, action items, milestone events, form definitions and responses, tickets, messages, to-do templates, and audit logs are Firestore collections. Cohort members and ticket messages are subcollections. This pass does not import a live spreadsheet.
