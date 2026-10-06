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

## Import the existing spreadsheet

The Apps Script workbook is the database. `npm run import-sheet` reads that Google Sheet and writes the same tables into Firestore: cohorts, `COHORT: 2026` rosters, staff and students, phases, milestones, forms and `FORM: …` answers, tickets, messages, resources, and the audit log. Sheet dates are stored as `YYYY-MM-DD` or ISO timestamps. Emails are lowercased so they match Google sign-in.

Try it on the emulator first. Start `npm run emulators`, then in another terminal:

```bash
export GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON=/path/to/service-account.json
npm run import-sheet -- "https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit" --dry-run
npm run import-sheet -- "https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit"
npm run dev
```

Share the spreadsheet with the service account email (Viewer is enough). The same JSON used for Drive sync works when that account can read the sheet. If the variable is unset, the command uses application default credentials from `gcloud auth application-default login`.

`--dry-run` prints row counts and does not write. A real import replaces each collection that the workbook contains, including cohort members, ticket messages, and audit logs, so running it again does not duplicate rows. Collections whose tabs are missing are left as they are. Every `FORM:` tab is stored in one response collection, so the import keeps the answers from the form tabs that are present. `CONTENT_PAGES` rows are copied into resources when that resource id is not already there.

Sign-in still uses the email on `USERS-STAFF` or `USERS-STUDENTS`. The import does not create passwords. On the emulator, Google sign-in is the path for those real emails. The demo password buttons only exist for the seeded example accounts.

To load the same workbook into a live project after deploy:

```bash
npm run import-sheet -- "https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit" --production --project=YOUR_PROJECT_ID
```

That command uses the service account as Firebase Admin. Give that account the Cloud Datastore User role on the project. Leave `FIRESTORE_EMULATOR_HOST` unset.

## Deploy

Cloud Functions need the Blaze plan. The safest order is: import into the emulator and click through one student, one supervisor, and one coordinator, then deploy, then import into the live project.

1. Create a Firebase project and turn on Authentication → Google, and Firestore.
2. Add a web app. Put its config in `web/.env.production` (this file is not committed):

```bash
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
```

Do not set `VITE_USE_EMULATORS` for that build.

3. Create `functions/.env` with `EE_TIMEZONE=Asia/Hong_Kong`. To create and share cohort Drive folders, also set `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` to the service account key JSON, or to a path to that file, and share the cohort folder with that account. Without it, the hub still runs and the Admin Drive panel says sync is not configured.

4. From this repo:

```bash
firebase login
firebase use --add
npm run build
npm run build:functions
firebase deploy
```

5. In Authentication → Settings → Authorized domains, include the Hosting domain Firebase prints after deploy.
6. Run the import command with `--production` and the same project id. The first sign-in is Google, using an email that is already on the staff or student tab.

Hosting serves the built web app. The callable is `eeHub`. Firestore rules deny all client writes, so the function and the import script are the only writers.
