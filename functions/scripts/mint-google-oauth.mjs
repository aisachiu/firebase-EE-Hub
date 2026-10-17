// Mint the one refresh token used by eeHub and notificationSweep.
// Sign in as the school mailbox (for VSA, sec-ict@vsa.edu.hk).
// Does not write secrets to disk.

import { createServer } from 'node:http';
import { google } from 'googleapis';

const CLIENT_ID = process.env.EE_GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.EE_GOOGLE_OAUTH_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.EE_GOOGLE_OAUTH_REDIRECT_URI || 'http://127.0.0.1:8765/oauth/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.send',
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  fail('Set EE_GOOGLE_OAUTH_CLIENT_ID and EE_GOOGLE_OAUTH_CLIENT_SECRET, then run this again.');
}

const redirect = new URL(REDIRECT_URI);
if (redirect.protocol !== 'http:' || !redirect.port) {
  fail(`EE_GOOGLE_OAUTH_REDIRECT_URI must be an http://127.0.0.1:port/path URL. Got ${REDIRECT_URI}`);
}

const oauth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const consentUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

function codeFromArgs() {
  const flag = process.argv.find((arg) => arg.startsWith('--code='));
  return flag ? flag.slice('--code='.length).trim() : '';
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url || '/', REDIRECT_URI);
      if (url.pathname !== redirect.pathname) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      const oauthError = url.searchParams.get('error');
      const code = url.searchParams.get('code') || '';
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>EE Hub</title><p>You can close this window and return to the terminal.</p>');
      server.close();
      if (oauthError) reject(new Error(`Google returned ${oauthError}.`));
      else if (!code) reject(new Error('The redirect did not include an authorization code.'));
      else resolve(code);
    });
    server.listen(Number(redirect.port), redirect.hostname, () => {
      console.log(`Waiting for the redirect on ${REDIRECT_URI}`);
      console.log('Open this URL while signed in as the school account:');
      console.log(consentUrl);
    });
    server.on('error', reject);
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the consent redirect. Run again with --code=THE_CODE if you already have one.'));
    }, 5 * 60 * 1000).unref();
  });
}

const provided = codeFromArgs();
const code = provided || await waitForCode();
let tokens;
try {
  const exchanged = await oauth.getToken(code);
  tokens = exchanged.tokens;
} catch (error) {
  fail(error instanceof Error ? error.message : 'The authorization code could not be exchanged.');
}

if (!tokens.refresh_token) {
  fail('Google did not return a refresh token. Revoke the app at https://myaccount.google.com/permissions and run this again.');
}

console.log('');
console.log('Add these to functions/.env and redeploy. Do not commit them.');
console.log(`EE_GOOGLE_OAUTH_CLIENT_ID=${CLIENT_ID}`);
console.log(`EE_GOOGLE_OAUTH_CLIENT_SECRET=${CLIENT_SECRET}`);
console.log(`EE_GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log('');
console.log('Then open Admin → Google account and check the connection.');
