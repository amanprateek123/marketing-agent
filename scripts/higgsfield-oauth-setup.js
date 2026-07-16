#!/usr/bin/env node
/**
 * One-time interactive setup: completes Higgsfield's OAuth authorization-code
 * + PKCE flow to mint a refresh token for the marketing-agent-backend OAuth
 * client (client_id registered via dynamic client registration against
 * https://mcp.higgsfield.ai/oauth2/register).
 *
 * Run this ONCE, locally, on a machine with a browser:
 *   node scripts/higgsfield-oauth-setup.js
 *
 * It starts a temporary local server on http://localhost:8976, prints a
 * Higgsfield login URL, waits for you to approve in your browser, then
 * exchanges the resulting code for tokens and prints the refresh token.
 * Copy that refresh token into HIGGSFIELD_OAUTH_REFRESH_TOKEN on the actual
 * server's .env — the server then mints its own short-lived access tokens
 * from it forever, with no browser involved again.
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const CLIENT_ID = '6NpY0cCMg6i5I9Rj';
const REDIRECT_URI = 'http://localhost:8976/callback';
const AUTH_ENDPOINT = 'https://mcp.higgsfield.ai/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://mcp.higgsfield.ai/oauth2/token';
const SCOPE = 'openid email offline_access';
const PORT = 8976;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const codeVerifier = base64url(crypto.randomBytes(32));
const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
const state = base64url(crypto.randomBytes(16));

const authUrl = new URL(AUTH_ENDPOINT);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', state);

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const error = url.searchParams.get('error');
  const returnedState = url.searchParams.get('state');
  const code = url.searchParams.get('code');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorization failed: ${error}`);
    console.error(`\nAuthorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('State mismatch — possible CSRF, aborting.');
    console.error('\nState mismatch — aborting.');
    server.close();
    process.exit(1);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Authorized. You can close this tab and go back to your terminal.');

    console.log('\n=== Success ===');
    console.log('Save these on your SERVER (not in git):\n');
    console.log(`HIGGSFIELD_OAUTH_CLIENT_ID=${CLIENT_ID}`);
    console.log(`HIGGSFIELD_OAUTH_REFRESH_TOKEN=${tokens.refresh_token ?? '(none returned — check response below)'}`);
    console.log('\nFull token response (for debugging):');
    console.log(JSON.stringify(tokens, null, 2));
  } catch (err) {
    console.error('\nToken exchange failed:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Token exchange failed — check your terminal.');
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 500);
  }
});

server.listen(PORT, () => {
  console.log('Open this URL in your browser and log in with your Higgsfield account:\n');
  console.log(authUrl.toString());
  console.log(`\nWaiting for redirect to ${REDIRECT_URI} ...`);
});
