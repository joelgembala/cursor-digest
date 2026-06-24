import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Tasks.ReadWrite offline_access';
const POLL_INTERVAL_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRequiredEnv(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing environment variable: ${name}. Set it in your launchd plist or shell.`);
  }
  return val;
}

function tokenFilePath(config) {
  const outputDir = config.reports.outputDir.replace(/^~/, process.env.HOME);
  return join(outputDir, '.ms-todo-tokens.json');
}

function loadTokens(config) {
  const path = tokenFilePath(config);
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTokens(config, tokens) {
  const path = tokenFilePath(config);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), 'utf-8');
}

function authEndpoint(tenantId, path) {
  const authority = tenantId || 'consumers';
  return `https://login.microsoftonline.com/${authority}/oauth2/v2.0/${path}`;
}

async function acquireTokenByDeviceCode(clientId, tenantId, clientSecret) {
  const deviceRes = await fetch(authEndpoint(tenantId, 'devicecode'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES }),
  });

  if (!deviceRes.ok) {
    const body = await deviceRes.text();
    throw new Error(`Device code request failed (${deviceRes.status}): ${body}`);
  }

  const deviceData = await deviceRes.json();
  console.log('\n' + deviceData.message + '\n');

  const pollParams = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceData.device_code,
  });
  if (clientSecret) pollParams.set('client_secret', clientSecret);

  const expiresAt = Date.now() + deviceData.expires_in * 1000;
  while (Date.now() < expiresAt) {
    await sleep(deviceData.interval ? deviceData.interval * 1000 : POLL_INTERVAL_MS);

    const tokenRes = await fetch(authEndpoint(tenantId, 'token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: pollParams,
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error === 'authorization_pending') continue;
    if (tokenData.error === 'slow_down') {
      await sleep(5_000);
      continue;
    }
    if (tokenData.error) {
      throw new Error(`Token poll error: ${tokenData.error} - ${tokenData.error_description}`);
    }

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
    };
  }

  throw new Error('Device code flow timed out. Please try again.');
}

async function refreshAccessToken(clientId, tenantId, clientSecret, refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: SCOPES,
  });
  if (clientSecret) params.set('client_secret', clientSecret);

  const res = await fetch(authEndpoint(tenantId, 'token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error} - ${data.error_description}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function getAccessToken(config) {
  const clientId = getRequiredEnv('MS_TODO_CLIENT_ID');
  const tenantId = process.env.MS_TODO_TENANT_ID || '';
  const clientSecret = process.env.MS_TODO_CLIENT_SECRET || '';

  const tokens = loadTokens(config);
  if (!tokens || !tokens.refreshToken) {
    throw new Error('No Microsoft auth tokens found. Run: node digest.mjs --setup-todo');
  }

  if (tokens.expiresAt && Date.now() < tokens.expiresAt - 60_000) {
    return tokens.accessToken;
  }

  console.log('  [todo] Access token expired, refreshing...');
  const refreshed = await refreshAccessToken(clientId, tenantId, clientSecret, tokens.refreshToken);
  saveTokens(config, refreshed);
  return refreshed.accessToken;
}

async function graphGet(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API GET ${url} failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function graphPost(url, body, accessToken) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph API POST ${url} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function findOrCreateList(accessToken, listName) {
  const data = await graphGet(`${GRAPH_BASE}/me/todo/lists`, accessToken);
  const existing = data.value.find(
    (list) => list.displayName.toLowerCase() === listName.toLowerCase(),
  );
  if (existing) return existing.id;

  console.log(`  [todo] List "${listName}" not found, creating...`);
  const created = await graphPost(`${GRAPH_BASE}/me/todo/lists`, { displayName: listName }, accessToken);
  return created.id;
}

async function getIncompleteTaskTitles(accessToken, listId) {
  const url = `${GRAPH_BASE}/me/todo/lists/${listId}/tasks?$top=200`;

  const titles = [];
  let nextLink = url;
  while (nextLink) {
    const data = await graphGet(nextLink, accessToken);
    for (const task of data.value) {
      if (task.status !== 'completed') {
        titles.push(task.title);
      }
    }
    nextLink = data['@odata.nextLink'] || null;
  }
  return titles;
}

async function addTask(accessToken, listId, title, dueDate, notes) {
  const body = {
    title,
    body: { content: notes || '', contentType: 'text' },
    dueDateTime: {
      dateTime: dueDate.toISOString().slice(0, 19),
      timeZone: 'UTC',
    },
  };
  await graphPost(`${GRAPH_BASE}/me/todo/lists/${listId}/tasks`, body, accessToken);
}

/**
 * Interactive setup: run Device Code Flow and persist tokens.
 */
export async function setupAuth(config) {
  const clientId = getRequiredEnv('MS_TODO_CLIENT_ID');
  const tenantId = process.env.MS_TODO_TENANT_ID || '';
  const clientSecret = process.env.MS_TODO_CLIENT_SECRET || '';

  console.log('[setup] Starting Microsoft To Do authentication...');
  const tokens = await acquireTokenByDeviceCode(clientId, tenantId, clientSecret);
  saveTokens(config, tokens);
  console.log('[setup] Authentication successful. Tokens saved.');
  console.log(`[setup] Token file: ${tokenFilePath(config)}`);
}

/**
 * Create Microsoft To Do tasks for each action item.
 * Drop-in replacement for the old createReminders().
 */
export async function createTasks(config, actionItems, dueDate) {
  const listName = config.todo.listName;

  console.log(`  [todo] Authenticating with Microsoft Graph...`);
  const accessToken = await getAccessToken(config);

  console.log(`  [todo] Targeting list "${listName}"`);
  const listId = await findOrCreateList(accessToken, listName);

  const existingTitles = new Set(await getIncompleteTaskTitles(accessToken, listId));

  let created = 0;
  let skipped = 0;
  const failed = [];

  for (const item of actionItems) {
    if (existingTitles.has(item)) {
      skipped++;
      console.log(`  [todo] Skipped (already exists): ${item}`);
      continue;
    }
    try {
      await addTask(accessToken, listId, item, dueDate, 'Generated by AutoBrief');
      created++;
      console.log(`  [todo] Created: ${item}`);
    } catch (err) {
      failed.push({ title: item, dueDate: dueDate.toISOString() });
      console.error(`  [todo] Failed to create "${item}": ${err.message}`);
    }
  }

  console.log(
    `  [todo] ${created} created, ${skipped} skipped (duplicates), ${failed.length} failed, out of ${actionItems.length} total.`,
  );

  return { created, skipped, failed };
}

function pendingFilePath(config) {
  const outputDir = config.reports.outputDir.replace(/^~/, process.env.HOME);
  return join(outputDir, 'pending-tasks.json');
}

export function loadPendingTasks(config) {
  try {
    const raw = readFileSync(pendingFilePath(config), 'utf-8');
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

export function savePendingTasks(config, items) {
  const filePath = pendingFilePath(config);
  mkdirSync(join(filePath, '..'), { recursive: true });
  if (items.length === 0) {
    try { writeFileSync(filePath, '[]', 'utf-8'); } catch { /* ignore */ }
  } else {
    writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf-8');
  }
}
