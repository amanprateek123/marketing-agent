#!/usr/bin/env node
/**
 * Step 1 of the one-time Higgsfield OAuth setup: generates a fresh PKCE
 * verifier/challenge + state, prints the login URL, and prints the verifier
 * so the token exchange (step 2, done separately) can be completed manually
 * regardless of whether the browser can actually reach a local redirect
 * listener.
 *
 * Run: node scripts/higgsfield-oauth-init.js
 */

const crypto = require('crypto');
const { URL } = require('url');

const CLIENT_ID = '6NpY0cCMg6i5I9Rj';
const REDIRECT_URI = 'http://localhost:8976/callback';
const AUTH_ENDPOINT = 'https://mcp.higgsfield.ai/oauth2/authorize';
const SCOPE = 'openid email offline_access';

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

console.log('AUTH_URL=' + authUrl.toString());
console.log('CODE_VERIFIER=' + codeVerifier);
console.log('STATE=' + state);
