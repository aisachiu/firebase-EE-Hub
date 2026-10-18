import assert from 'node:assert/strict';
import test from 'node:test';
import { createGmailMailer, gmailConfigured, gmailNotConfiguredMessage } from './gmail';
import {
  DEFAULT_OAUTH_REDIRECT,
  DRIVE_SCOPE,
  GMAIL_SEND_SCOPE,
  getGoogleAuth,
  GOOGLE_SCOPES,
  googleConsentUrl,
  googleOAuthConfigured,
  googleOAuthParts,
  googleOAuthSecrets,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI,
  OAUTH_REFRESH_TOKEN,
  SHEETS_SCOPE,
} from './googleAuth';
import { HubError } from './util';

const CLIENT_ID = 'ee-hub.apps.googleusercontent.com';
const CLIENT_SECRET = 'oauth-client-secret-value';
const REFRESH_TOKEN = 'oauth-refresh-token-value';
const SOURCE = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN };

const ENV_NAMES = [
  'EE_GOOGLE_OAUTH_CLIENT_ID',
  'EE_GOOGLE_OAUTH_CLIENT_SECRET',
  'EE_GOOGLE_OAUTH_REFRESH_TOKEN',
  'EE_GOOGLE_OAUTH_REDIRECT_URI',
  'EE_DRIVE_SERVICE_ACCOUNT_JSON',
  'EE_GMAIL_SERVICE_ACCOUNT_JSON',
  'EE_GMAIL_SENDER',
];

function restoreEnv(previous: Record<string, string | undefined>) {
  ENV_NAMES.forEach((name) => {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  });
}

test('one OAuth token covers Drive, Sheets, and Gmail send', () => {
  assert.deepEqual(GOOGLE_SCOPES, [DRIVE_SCOPE, SHEETS_SCOPE, GMAIL_SEND_SCOPE]);
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive');
  assert.equal(SHEETS_SCOPE, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(GMAIL_SEND_SCOPE, 'https://www.googleapis.com/auth/gmail.send');
});

test('OAuth is not configured until the client id, secret, and refresh token are all set', () => {
  assert.equal(googleOAuthConfigured({}), false);
  assert.deepEqual(googleOAuthParts({}).missing, [
    'EE_GOOGLE_OAUTH_CLIENT_ID',
    'EE_GOOGLE_OAUTH_CLIENT_SECRET',
    'EE_GOOGLE_OAUTH_REFRESH_TOKEN',
  ]);
  assert.equal(googleOAuthConfigured({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), false);
  assert.deepEqual(googleOAuthParts({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }).missing, ['EE_GOOGLE_OAUTH_REFRESH_TOKEN']);
  assert.equal(googleOAuthConfigured(SOURCE), true);
  assert.equal(googleConsentUrl({}), '');
  const url = googleConsentUrl({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
  assert.match(decoded, new RegExp(`client_id=${CLIENT_ID}`));
  assert.match(decoded, /access_type=offline/);
  assert.match(decoded, /prompt=consent/);
  assert.ok(decoded.includes(DEFAULT_OAUTH_REDIRECT));
  GOOGLE_SCOPES.forEach((scope) => assert.ok(decoded.includes(scope)));
  assert.equal(url.includes(CLIENT_SECRET), false);
  assert.equal(url.includes(REFRESH_TOKEN), false);
});

test('omitted source reads Secret Manager, then process.env for the emulator', async () => {
  const names = [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REFRESH_TOKEN, OAUTH_REDIRECT_URI];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originals = googleOAuthSecrets.map((secret) => secret.value);
  const secretValues = ['secret-client-id', 'secret-client-secret', 'secret-refresh-token'];
  try {
    googleOAuthSecrets.forEach((secret, index) => {
      secret.value = () => secretValues[index];
    });
    process.env[OAUTH_CLIENT_ID] = 'stale-client-id';
    process.env[OAUTH_CLIENT_SECRET] = 'stale-client-secret';
    process.env[OAUTH_REFRESH_TOKEN] = 'stale-refresh-token';
    process.env[OAUTH_REDIRECT_URI] = 'http://127.0.0.1:9999/oauth/callback';

    const fromSecrets = googleOAuthParts();
    assert.equal(fromSecrets.clientId, 'secret-client-id');
    assert.equal(fromSecrets.clientSecret, 'secret-client-secret');
    assert.equal(fromSecrets.refreshToken, 'secret-refresh-token');
    assert.equal(fromSecrets.redirectUri, 'http://127.0.0.1:9999/oauth/callback');
    assert.deepEqual(fromSecrets.missing, []);
    const auth = await getGoogleAuth();
    assert.equal(auth.credentials.refresh_token, 'secret-refresh-token');

    const explicit = googleOAuthParts({});
    assert.deepEqual(explicit.missing, [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REFRESH_TOKEN]);
    assert.equal(explicit.clientId, '');

    googleOAuthSecrets.forEach((secret) => {
      secret.value = () => {
        throw new Error('secret is not mounted');
      };
    });
    const fromEnv = googleOAuthParts();
    assert.equal(fromEnv.clientId, 'stale-client-id');
    assert.equal(fromEnv.clientSecret, 'stale-client-secret');
    assert.equal(fromEnv.refreshToken, 'stale-refresh-token');
    assert.equal(googleOAuthConfigured(), true);
  } finally {
    googleOAuthSecrets.forEach((secret, index) => {
      secret.value = originals[index];
    });
    names.forEach((name) => {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    });
  }
});

test('getGoogleAuth builds an OAuth client and refuses a partial configuration', async () => {
  const auth = await getGoogleAuth(SOURCE);
  assert.equal(auth.credentials.refresh_token, REFRESH_TOKEN);
  const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [...GOOGLE_SCOPES] });
  const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
  assert.ok(decoded.includes(CLIENT_ID));
  assert.ok(decoded.includes('access_type=offline'));
  GOOGLE_SCOPES.forEach((scope) => assert.ok(decoded.includes(scope)));
  assert.equal(url.includes(CLIENT_SECRET), false);
  assert.equal(decoded.includes(REFRESH_TOKEN), false);

  await assert.rejects(
    () => getGoogleAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: '' }),
    (error: unknown) => {
      assert.ok(error instanceof HubError);
      assert.match(error.message, /EE_GOOGLE_OAUTH_REFRESH_TOKEN/);
      assert.equal(error.message.includes(CLIENT_SECRET), false);
      return true;
    },
  );
  await assert.rejects(() => getGoogleAuth({}), /EE_GOOGLE_OAUTH_CLIENT_ID/);
});

test('service account environment variables do not configure Google', async () => {
  const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  ENV_NAMES.forEach((name) => { delete process.env[name]; });
  process.env.EE_DRIVE_SERVICE_ACCOUNT_JSON = 'PRIVATE-SA-KEY-VALUE';
  process.env.EE_GMAIL_SERVICE_ACCOUNT_JSON = 'PRIVATE-GMAIL-KEY-VALUE';
  process.env.EE_GMAIL_SENDER = 'old-sender@school.edu';
  try {
    assert.equal(googleOAuthConfigured(), false);
    assert.equal(gmailConfigured(), false);
    await assert.rejects(() => getGoogleAuth(), (error: unknown) => {
      assert.ok(error instanceof HubError);
      assert.match(error.message, /EE_GOOGLE_OAUTH_CLIENT_ID/);
      assert.match(error.message, /no longer used/);
      assert.match(error.message, /Domain-wide delegation is not required/);
      assert.equal(error.message.includes('PRIVATE-SA-KEY-VALUE'), false);
      assert.equal(error.message.includes('PRIVATE-GMAIL-KEY-VALUE'), false);
      return true;
    });
    assert.match(gmailNotConfiguredMessage(), /EE_GOOGLE_OAUTH_REFRESH_TOKEN/);
    assert.equal(gmailNotConfiguredMessage().includes('PRIVATE-SA-KEY-VALUE'), false);
    await assert.rejects(() => createGmailMailer(), /EE_GOOGLE_OAUTH_CLIENT_SECRET/);
  } finally {
    restoreEnv(previous);
  }
});

test('a Gmail mailer sends as the connected mailbox without a service account', async () => {
  const sent: Array<{ userId?: string; requestBody?: { raw?: string } }> = [];
  const mailer = await createGmailMailer({
    sender: 'sec-ict@vsa.edu.hk',
    gmail: {
      users: {
        messages: {
          async send(args) {
            sent.push(args);
            return {};
          },
        },
      },
    },
  });
  await mailer.send({ to: ['student@vsa.edu.hk'], subject: 'Reminder', body: 'Hello' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, 'me');
  const raw = Buffer.from(String(sent[0].requestBody?.raw || ''), 'base64url').toString('utf8');
  assert.match(raw, /From: sec-ict@vsa.edu.hk/);
  assert.match(raw, /To: student@vsa.edu.hk/);
  assert.equal(raw.includes(CLIENT_SECRET), false);
});
