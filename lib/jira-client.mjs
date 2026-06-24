/**
 * Jira Cloud REST API client for creating stories from the weekly digest.
 * Uses Basic Auth (email + API token) and native fetch().
 */

function getAuth() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token) {
    throw new Error('JIRA_EMAIL and JIRA_API_TOKEN environment variables are required for Jira integration.');
  }
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function jiraFetch(siteUrl, path, options = {}) {
  const url = `${siteUrl.replace(/\/+$/, '')}/rest/api/3${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': getAuth(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Jira API ${response.status} ${options.method || 'GET'} ${url}: ${body || '(empty response)'}`);
  }
  return body ? JSON.parse(body) : null;
}

/**
 * Cisco fiscal quarters:
 *   Q1 = Aug-Oct, Q2 = Nov-Jan, Q3 = Feb-Apr, Q4 = May-Jul
 */
function getCiscoFiscalQuarter() {
  const now = new Date();
  const month = now.getMonth() + 1;

  if (month >= 8 && month <= 10) return 'Q1';
  if (month >= 11 || month === 1) return 'Q2';
  if (month >= 2 && month <= 4) return 'Q3';
  return 'Q4';
}

/**
 * Search for the current quarter's parent Epic (e.g., "Q3 Apps Operational").
 * Returns the issue key (e.g., "INTRA-456") or null if not found.
 */
export async function findParentEpic(config) {
  const quarter = getCiscoFiscalQuarter();
  const projectKey = config.jira.projectKey;
  const jql = `project = ${projectKey} AND summary ~ "${quarter} Apps Operational" AND issuetype = Epic ORDER BY created DESC`;

  console.log(`  [jira] Searching for parent Epic: ${quarter} Apps Operational`);

  const result = await jiraFetch(config.jira.siteUrl, `/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=summary,key`);

  if (result.issues && result.issues.length > 0) {
    const epic = result.issues[0];
    console.log(`  [jira] Found parent Epic: ${epic.key} - ${epic.fields.summary}`);
    return epic.key;
  }

  console.log(`  [jira] No parent Epic found for "${quarter} Apps Operational". Stories will be created without a parent.`);
  return null;
}

/**
 * Look up a Jira user's accountId by display name.
 */
export async function lookupAccountId(config, displayName) {
  const result = await jiraFetch(config.jira.siteUrl, `/user/search?query=${encodeURIComponent(displayName)}&maxResults=5`);

  if (Array.isArray(result) && result.length > 0) {
    const match = result.find((u) => u.displayName === displayName) || result[0];
    console.log(`  [jira] Resolved "${displayName}" -> accountId: ${match.accountId}`);
    return match.accountId;
  }

  console.log(`  [jira] Could not find user "${displayName}". Stories will be unassigned.`);
  return null;
}

/**
 * Create a Jira Story issue.
 *
 * @param {object} config - Loaded config with jira section
 * @param {object} story  - { summary, description, storyPoints }
 * @param {string|null} parentKey    - Parent Epic key
 * @param {string|null} assigneeId   - Jira accountId
 * @returns {string} Created issue key
 */
export async function createStory(config, story, parentKey, assigneeId) {
  const fields = {
    project: { key: config.jira.projectKey },
    issuetype: { name: config.jira.issueType },
    summary: story.summary,
    description: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: story.description }],
        },
      ],
    },
  };

  if (parentKey) {
    fields.parent = { key: parentKey };
  }

  if (assigneeId) {
    fields.assignee = { id: assigneeId };
  }

  if (story.storyPoints) {
    fields.story_points = story.storyPoints;
  }

  const result = await jiraFetch(config.jira.siteUrl, '/issue', {
    method: 'POST',
    body: JSON.stringify({ fields }),
  });

  return result.key;
}

/**
 * Create multiple stories, resolving parent and assignee first.
 * Returns array of { key, summary } for each created story.
 */
export async function createStories(config, stories, dryRun) {
  if (!stories || stories.length === 0) {
    console.log('  [jira] No stories to create.');
    return [];
  }

  if (dryRun) {
    console.log(`  [jira] [dry-run] Would create ${stories.length} stories in ${config.jira.projectKey}:`);
    for (const s of stories) {
      console.log(`    - [${s.storyPoints} SP] ${s.summary}`);
    }
    return stories.map((s, i) => ({ key: `${config.jira.projectKey}-DRY${i + 1}`, summary: s.summary }));
  }

  const parentKey = await findParentEpic(config);
  const assigneeId = await lookupAccountId(config, config.jira.assignee);

  const created = [];
  for (const story of stories) {
    try {
      const key = await createStory(config, story, parentKey, assigneeId);
      console.log(`  [jira] Created: ${key} - ${story.summary}`);
      created.push({ key, summary: story.summary });
    } catch (err) {
      console.error(`  [jira] Failed to create "${story.summary}": ${err.message}`);
    }
  }

  console.log(`  [jira] ${created.length}/${stories.length} stories created.`);
  return created;
}
