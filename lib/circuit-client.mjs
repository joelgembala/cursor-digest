/**
 * circuit-client.mjs — OAuth 2.0 client credentials + chat completions
 * for Cisco's Circuit (chat-ai.cisco.com) Enterprise GenAI gateway.
 *
 * Ported from servicenow-mcp-server/src/servicenow_mcp/circuit_auth.py.
 *
 * Environment variables:
 *   BRIDGE_API_CLIENT_ID      OAuth client ID
 *   BRIDGE_API_CLIENT_SECRET  OAuth client secret
 *   BRIDGE_API_APP_KEY        AppKey sent in request body per Circuit API guide §6.2
 *   CIRCUIT_TOKEN_URL         Token endpoint (default: https://id.cisco.com/oauth2/default/v1/token)
 *   CIRCUIT_API_ENDPOINT      Base URL (default: https://chat-ai.cisco.com/)
 *   CIRCUIT_API_VERSION       Azure API version (default: 2025-04-01-preview)
 *   CIRCUIT_MODEL             Model / deployment name (default: gpt-5-nano)
 */

const DEFAULT_TOKEN_URL = 'https://id.cisco.com/oauth2/default/v1/token';
const DEFAULT_ENDPOINT = 'https://chat-ai.cisco.com/';
const DEFAULT_API_VERSION = '2025-04-01-preview';
const DEFAULT_MODEL = 'gpt-5-nano';
const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;

let cachedToken = null;
let tokenExpiresAt = 0;

async function refreshToken() {
  const clientId = process.env.BRIDGE_API_CLIENT_ID;
  const clientSecret = process.env.BRIDGE_API_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'BRIDGE_API_CLIENT_ID and BRIDGE_API_CLIENT_SECRET environment variables are required.'
    );
  }

  const tokenUrl = process.env.CIRCUIT_TOKEN_URL || DEFAULT_TOKEN_URL;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Circuit token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  const expiresIn = (data.expires_in || 3600) * 1000;
  tokenExpiresAt = Date.now() + expiresIn - TOKEN_SAFETY_MARGIN_MS;
}

async function getApiKey() {
  if (!cachedToken || Date.now() >= tokenExpiresAt) {
    await refreshToken();
  }
  return cachedToken;
}

/**
 * Send a chat completions request to Circuit.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} opts
 * @param {number} [opts.maxTokens=2048]
 * @param {number} [opts.temperature=0]
 * @returns {Promise<string>} The assistant message content.
 */
export async function chatCompletions(messages, { maxTokens = 2048, temperature = 0 } = {}) {
  const apiKey = await getApiKey();
  const endpoint = (process.env.CIRCUIT_API_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const apiVersion = process.env.CIRCUIT_API_VERSION || DEFAULT_API_VERSION;
  const model = process.env.CIRCUIT_MODEL || DEFAULT_MODEL;
  const appKey = process.env.BRIDGE_API_APP_KEY || '';

  const url = `${endpoint}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages,
      temperature,
      max_tokens: maxTokens,
      user: JSON.stringify({ appkey: appKey }),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Circuit chat completions failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}
