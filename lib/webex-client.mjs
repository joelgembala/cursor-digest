import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = join(__dirname, '..', '.webex-tokens.json');
const WEBEX_API_BASE = 'https://webexapis.com/v1';

const DEFAULT_SCOPES = [
  'spark:messages_read',
  'spark:rooms_read',
  'spark:kms',
  'meeting:transcripts_read',
  'meeting:participants_read',
  'meeting:schedules_read',
];

// --- Token management ---

function loadTokens() {
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
}

async function refreshAccessToken(tokens) {
  const clientId = process.env.WEBEX_CLIENT_ID;
  const clientSecret = process.env.WEBEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('WEBEX_CLIENT_ID and WEBEX_CLIENT_SECRET env vars are required for token refresh.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
  });

  const res = await fetch(`${WEBEX_API_BASE}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const now = Date.now();
  const updated = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    access_token_expires_at: now + data.expires_in * 1000,
    refresh_token_expires_at: now + data.refresh_token_expires_in * 1000,
    updated_at: new Date().toISOString(),
  };
  saveTokens(updated);
  return updated;
}

/**
 * Get a valid access token. Checks (in order):
 *   1. WEBEX_API_TOKEN env var (manual override / testing)
 *   2. .webex-tokens.json with auto-refresh
 */
async function getValidToken() {
  const envToken = process.env.WEBEX_API_TOKEN;
  if (envToken) return envToken;

  let tokens = loadTokens();
  if (!tokens?.access_token) return null;

  const now = Date.now();
  const bufferMs = 5 * 60 * 1000;

  if (tokens.access_token_expires_at && now >= tokens.access_token_expires_at - bufferMs) {
    if (tokens.refresh_token_expires_at && now >= tokens.refresh_token_expires_at) {
      console.error('  [webex] Refresh token expired. Re-run: node digest.mjs --setup-webex');
      return null;
    }
    console.log('  [webex] Access token expired, refreshing...');
    tokens = await refreshAccessToken(tokens);
    console.log('  [webex] Token refreshed successfully.');
  }

  return tokens.access_token;
}

// --- OAuth setup (one-time) ---

/**
 * Run the OAuth Authorization Code flow with PKCE.
 * Opens a local HTTP server to catch the redirect callback,
 * exchanges the code for tokens, and saves them.
 */
export async function setupOAuth(config) {
  const clientId = process.env.WEBEX_CLIENT_ID;
  const clientSecret = process.env.WEBEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Set WEBEX_CLIENT_ID and WEBEX_CLIENT_SECRET environment variables before running setup.\n' +
      'Find these on your integration page at developer.webex.com.'
    );
  }

  const redirectUri = config.webex?.redirectUri || 'http://localhost:8888/callback';
  const { port, pathname } = new URL(redirectUri);

  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const authUrl = new URL(`${WEBEX_API_BASE}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', DEFAULT_SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname !== pathname) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const returnedState = url.searchParams.get('state');
      if (returnedState !== state) {
        res.writeHead(400);
        res.end('State mismatch — possible CSRF. Try again.');
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('No authorization code received.');
        server.close();
        reject(new Error('No authorization code in callback'));
        return;
      }

      try {
        const tokenBody = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        });

        const tokenRes = await fetch(`${WEBEX_API_BASE}/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody,
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text().catch(() => '');
          throw new Error(`Token exchange failed (${tokenRes.status}): ${errText.slice(0, 300)}`);
        }

        const data = await tokenRes.json();
        const now = Date.now();
        const tokens = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          access_token_expires_at: now + data.expires_in * 1000,
          refresh_token_expires_at: now + data.refresh_token_expires_in * 1000,
          created_at: new Date().toISOString(),
        };
        saveTokens(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Webex authorization successful!</h2><p>You can close this tab and return to your terminal.</p>');
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Token exchange failed: ${err.message}`);
        server.close();
        reject(err);
      }
    });

    server.listen(parseInt(port, 10), () => {
      console.log('\n  Open this URL in your browser to authorize:\n');
      console.log(`  ${authUrl.toString()}\n`);
      console.log(`  Waiting for callback on ${redirectUri}...\n`);
    });
  });
}

// --- API helpers ---

async function webexFetch(path, token) {
  const url = `${WEBEX_API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webex API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * List Webex spaces the authenticated user belongs to.
 * Used by --list-spaces to help populate config.json.
 */
export async function listSpaces() {
  const token = await getValidToken();
  if (!token) {
    throw new Error('No Webex token available. Run: node digest.mjs --setup-webex');
  }

  const data = await webexFetch('/rooms?max=100&sortBy=lastactivity', token);
  return (data.items || []).map((room) => ({
    id: room.id,
    title: room.title,
    type: room.type,
    lastActivity: room.lastActivity,
  }));
}

const PROXIMITY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Filter group room messages to only those in conversations the owner participated in.
 * Uses three criteria: direct authorship, shared thread, and time proximity.
 */
function filterGroupMessages(messages, ownerEmail) {
  const ownerMessages = messages.filter((m) => m.sender === ownerEmail);
  if (ownerMessages.length === 0) return [];

  const ownerThreadIds = new Set();
  const ownerMessageIds = new Set();

  for (const m of ownerMessages) {
    ownerMessageIds.add(m.id);
    if (m.parentId) ownerThreadIds.add(m.parentId);
  }

  const ownerTimestamps = ownerMessages.map((m) => m.timestamp.getTime());

  return messages.filter((m) => {
    if (m.sender === ownerEmail) return true;

    if (m.parentId && ownerThreadIds.has(m.parentId)) return true;
    if (m.parentId && ownerMessageIds.has(m.parentId)) return true;
    if (ownerThreadIds.has(m.id)) return true;

    const msgTime = m.timestamp.getTime();
    for (const t of ownerTimestamps) {
      if (Math.abs(msgTime - t) <= PROXIMITY_WINDOW_MS) return true;
    }

    return false;
  });
}

/**
 * Fetch messages from configured Webex spaces within a date range.
 * For group rooms, filters to conversations the owner participated in.
 * For DMs, includes all messages.
 */
export async function fetchSpaceMessages(config, start, end) {
  const token = await getValidToken();
  if (!token) return [];

  const spaces = config.webex?.spaces;
  if (!spaces || spaces.length === 0) return [];

  const ownerEmail = config.persona?.email;
  const results = [];

  for (const space of spaces) {
    try {
      const params = new URLSearchParams({
        roomId: space.id,
        max: '200',
        before: end.toISOString(),
      });

      const data = await webexFetch(`/messages?${params}`, token);
      const items = data.items || [];

      let dateFiltered = items
        .filter((msg) => new Date(msg.created) >= start)
        .reverse()
        .map((msg) => ({
          id: msg.id,
          parentId: msg.parentId || null,
          sender: msg.personEmail || 'unknown',
          text: msg.text || '',
          timestamp: new Date(msg.created),
          isOwner: ownerEmail ? msg.personEmail === ownerEmail : false,
        }));

      if (space.type === 'group' && ownerEmail) {
        dateFiltered = filterGroupMessages(dateFiltered, ownerEmail);
      }

      if (dateFiltered.length > 0) {
        results.push({
          spaceId: space.id,
          spaceName: space.name || space.id,
          messages: dateFiltered,
        });
      }
    } catch (err) {
      console.error(`  [webex] Warning: Failed to fetch space "${space.name || space.id}": ${err.message}`);
    }
  }

  return results;
}
