import { chatCompletions } from './circuit-client.mjs';

/**
 * Summarize a day's work from parsed transcripts.
 * Returns { accomplishments: string[], actionItems: string[], blockers: string[], rawMarkdown: string }
 */
export async function summarizeDaily(config, transcripts, webexMessages, dateStr) {
  const transcriptText = formatTranscriptsForPrompt(transcripts);
  const webexText = formatWebexForPrompt(webexMessages);

  const raw = await chatCompletions(
    [{ role: 'user', content: buildDailyPrompt(config, transcriptText, webexText, dateStr) }],
    { maxTokens: 2048 },
  );

  return parseDailySummary(raw);
}

/**
 * Synthesize a weekly report from daily summaries (preferred) or raw transcripts (fallback).
 * Returns { markdown: string }
 */
export async function summarizeWeekly(config, dailySummaries, transcripts, webexMessages, weekStart, weekEnd) {
  let inputText;

  if (dailySummaries && dailySummaries.length > 0) {
    inputText = dailySummaries
      .map((s) => `## ${s.date}\n\n${s.content}`)
      .join('\n\n---\n\n');
  } else if ((transcripts && transcripts.length > 0) || (webexMessages && webexMessages.length > 0)) {
    const parts = [];
    if (transcripts && transcripts.length > 0) {
      parts.push('## Cursor IDE Sessions\n\n' + formatTranscriptsForPrompt(transcripts));
    }
    if (webexMessages && webexMessages.length > 0) {
      parts.push('## Webex Conversations\n\n' + formatWebexForPrompt(webexMessages));
    }
    inputText = parts.join('\n\n---\n\n');
  } else {
    return { markdown: '*No activity recorded this week.*' };
  }

  const markdown = await chatCompletions(
    [{ role: 'user', content: buildWeeklyPrompt(config, inputText, weekStart, weekEnd) }],
    { maxTokens: 4096 },
  );

  return { markdown };
}

function formatTranscriptsForPrompt(transcripts) {
  const maxPerSession = 3000;
  const maxTotal = 30000;

  const sections = [];
  let totalLen = 0;

  for (const t of transcripts) {
    if (totalLen >= maxTotal) break;

    const queries = t.userQueries.join('\n- ');
    const actions = t.assistantActions.slice(0, 10).join('\n- ');

    let section = `### Session: ${t.sessionId} (${t.project})\n**Time:** ${t.timestamp.toISOString()}\n\n**User requests:**\n- ${queries}\n\n**Actions taken:**\n- ${actions}`;

    if (section.length > maxPerSession) {
      section = section.slice(0, maxPerSession) + '\n[...truncated]';
    }

    sections.push(section);
    totalLen += section.length;
  }

  return sections.join('\n\n---\n\n');
}

function formatWebexForPrompt(webexMessages) {
  if (!webexMessages || webexMessages.length === 0) return '';

  const maxPerSpace = 3000;
  const maxTotal = 15000;
  const sections = [];
  let totalLen = 0;

  for (const space of webexMessages) {
    if (totalLen >= maxTotal) break;

    const lines = space.messages.map((m) => {
      const time = m.timestamp.toISOString().slice(11, 16);
      const sender = m.sender.split('@')[0];
      const tag = m.isOwner ? ' (you)' : '';
      const text = m.text.length > 300 ? m.text.slice(0, 300) + '...' : m.text;
      return `[${time}] ${sender}${tag}: ${text}`;
    });

    let section = `### Space: ${space.spaceName}\n${lines.join('\n')}`;
    if (section.length > maxPerSpace) {
      section = section.slice(0, maxPerSpace) + '\n[...truncated]';
    }

    sections.push(section);
    totalLen += section.length;
  }

  return sections.join('\n\n---\n\n');
}

function buildDailyPrompt(config, transcriptText, webexText, dateStr) {
  const persona = config.persona || {};
  const name = persona.name || 'the author';
  const role = persona.role || 'Project Manager';

  const hasTranscripts = transcriptText.length > 0;
  const hasWebex = webexText.length > 0;

  let sourcesDescription;
  if (hasTranscripts && hasWebex) {
    sourcesDescription = 'Cursor IDE session transcripts and Webex team conversations';
  } else if (hasWebex) {
    sourcesDescription = 'Webex team conversations';
  } else {
    sourcesDescription = 'Cursor IDE session transcripts';
  }

  let dataSections = '';
  if (hasTranscripts) {
    dataSections += `\n\nSOURCE 1 — CURSOR IDE SESSIONS:\n\n${transcriptText}`;
  }
  if (hasWebex) {
    dataSections += `\n\nSOURCE ${hasTranscripts ? '2' : '1'} — WEBEX CONVERSATIONS:\n\n${webexText}`;
  }

  const email = persona.email || '';
  const identityClause = email && hasWebex
    ? `\n\n${name}'s Webex email is ${email}. In the Webex messages below, ${name}'s own messages are marked with "(you)". Focus on conversations ${name} participated in — other people's messages are included only for context around ${name}'s involvement. Do not attribute other people's work or conversations to ${name}.`
    : '';

  return `You are summarizing a day's work for ${name}, a ${role} who uses Cursor IDE with AI assistance to direct technical work. ${name} is non-technical — they guide projects and coordinate with engineers, but don't write code themselves.${identityClause}

Analyze the following ${sourcesDescription} from ${dateStr} and produce a structured daily summary. Translate technical activity into progress and outcomes. For Webex conversations, capture decisions made, questions raised, and coordination that happened.

The input may contain activity from multiple distinct projects. Each Cursor session is tagged with a project name (in parentheses after the session ID). Treat each project as a separate initiative — do not merge or connect them unless the content explicitly links them.

Produce your response in EXACTLY this format (use these exact headers):

## What I Accomplished Today

Group bullets by project. Use **bold project name** as a label before each group. Example:

**App Store Gateway**
- [accomplishment related to this project]

**ServiceNow Integration**
- [accomplishment related to this project]

If all work was on one project, still label it.

## Action Items for Tomorrow
- [specific, actionable follow-up task — label with project name if multiple projects are active]

## Open Questions / Blockers
- [any unresolved issues or blockers, or "None" if none — label with project name if relevant]

Guidelines:
- Group related activities into single accomplishments (don't list every file edit separately)
- Keep projects separate — don't assume work on one project relates to another
- Include decisions, discussions, and coordination from Webex alongside Cursor work
- Describe outcomes and progress, not implementation mechanics
- Action items should be concrete next steps, not vague
- Keep accomplishments to 3-8 bullets total
- Keep action items to 2-6 bullets
- Write in first person ("I got...", "I worked on...", "I discussed...", "I coordinated...")
- Use plain language — avoid jargon like "PR", "SSM", "OAuth", "Lambda". If a technical term is unavoidable, briefly explain it.
- Derive human-friendly project names from the directory names in the transcripts (e.g., "app-store-mcp-server" becomes "App Store MCP Server")

---
${dataSections}`;
}

function buildWeeklyPrompt(config, inputText, weekStart, weekEnd) {
  const persona = config.persona || {};
  const name = persona.name || 'the author';
  const role = persona.role || 'Project Manager';
  const team = persona.team || '';
  const teamClause = team ? ` on the ${team} team` : '';

  const email = persona.email || '';
  const identityClause = email
    ? ` ${name}'s Webex messages are marked "(you)" in the input — focus on what ${name} did and discussed, not what others did independently.`
    : '';

  return `You are ghostwriting a weekly status update for ${name}, a ${role}${teamClause}. ${name} is non-technical — they manage projects and coordinate with engineers, but they do not write code themselves. The input below comes from AI-assisted coding sessions that ${name} directed using Cursor IDE, and may include Webex team conversations capturing discussions, decisions, and coordination.${identityClause}

Your job: translate that raw technical activity into a status update that sounds like ${name} wrote it. It should read like a natural message posted to a Microsoft Teams channel — not a corporate template, not an engineering log.

CRITICAL — Project separation: The input may contain work from multiple distinct projects. Keep them separate. Do not merge projects, infer connections between them, or assume that work on one project feeds into another unless the input explicitly says so. Each project should appear as its own paragraph under "What Moved Forward."

Use this structure:

# Week of ${weekStart} to ${weekEnd}

[2-3 sentence opener. What was the main theme or focus this week? What moved? Write conversationally in first person.]

## What Moved Forward

[Organize by project or initiative. Use **bold project name** followed by a short paragraph (2-4 sentences) describing what progressed, why it matters, and where things stand now. Use first person ("I", "we", "my team"). Prefer paragraphs over bullet lists — bullets are fine for sub-details within a paragraph, but the default should be narrative.]

## Where I Need Help

[Concrete asks, not abstract risks. Frame each as "I need [what] from [who/what team] to unblock [outcome]." If nothing is blocked, write "Nothing blocking right now." Do not invent blockers.]

## Coming Up Next Week

[3-5 priorities framed as goals or milestones from a PM perspective ("Get the automation to a working demo", "Follow up with the ESP team on…", "Get alignment on…"). Each item should represent a distinct initiative or decision — do not list sub-tasks of the same project as separate items. These must account for the blockers listed above: do not promise deliverables that depend on unresolved blockers. If something is blocked, the next-week item should be about unblocking it, not about the work that comes after.]

Tone and language rules:
- Write as ${name} — first person, conversational but professional
- Translate ALL technical jargon into business language. The reader is a manager who does not know what a "PR", "SSM parameter", "base path mapping", or "FastMCP" is. Describe outcomes and progress, not implementation mechanics.
- Say "pull request" or "code review" instead of "PR". Say "server" instead of "Lambda" or "container". Say "deployment" instead of "CI/CD pipeline". When a technical concept has no plain equivalent, briefly explain it in context.
- Keep the whole report under 400 words — someone should be able to read it in 90 seconds
- Do not use ### sub-headings under "What Moved Forward" — use **bold text** for project names inline
- Do not number items under "Coming Up Next Week" — use a simple bullet list with dashes

---

INPUT:

${inputText}`;
}

/**
 * Generate structured user stories from a weekly report's "Next Week Plan" section.
 * Returns an array of { summary, description, storyPoints }.
 */
export async function generateStories(config, weeklyMarkdown) {
  const raw = await chatCompletions(
    [{ role: 'user', content: buildStoryPrompt(weeklyMarkdown) }],
    { maxTokens: 4096 },
  );

  return parseStoriesFromResponse(raw);
}

function buildStoryPrompt(weeklyMarkdown) {
  return `You are a Jira story writer for a software engineering team. Given the following weekly status report, extract the "Coming Up Next Week" items and convert each into a well-structured Jira user story.

Each story must be sized at 1-3 story points:
- 1 SP: Simple, well-understood change; few files; no unknowns; < 1 day
- 2 SP: Moderate complexity; some integration; 1-2 days
- 3 SP: Upper bound; multiple components; some unknowns but bounded; 2-3 days

If an item would exceed 3 SP, split it into multiple smaller stories.

Respond with ONLY a JSON array (no markdown fences, no explanation). Each element must have exactly these fields:
- "summary": Action-verb format ("Implement...", "Add...", "Create...", "Fix...")
- "description": 2-4 sentences of context plus acceptance criteria in checkbox format
- "storyPoints": 1, 2, or 3

Example response format:
[
  {
    "summary": "Implement user authentication for API endpoints",
    "description": "Add JWT-based authentication to the REST API endpoints. Currently the endpoints are unprotected.\\n\\nAcceptance Criteria:\\n- [ ] Auth middleware validates JWT tokens\\n- [ ] Unauthorized requests return 401\\n- [ ] Unit tests cover auth flow",
    "storyPoints": 2
  }
]

---

WEEKLY REPORT:

${weeklyMarkdown}`;
}

function parseStoriesFromResponse(raw) {
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const stories = JSON.parse(jsonStr);
    if (!Array.isArray(stories)) return [];
    return stories.filter((s) => s.summary && s.description && s.storyPoints);
  } catch {
    console.error('  [stories] Failed to parse Circuit response as JSON. Raw output:');
    console.error(raw.slice(0, 500));
    return [];
  }
}

function parseDailySummary(rawMarkdown) {
  const accomplishments = extractBullets(rawMarkdown, 'What I Accomplished Today');
  const actionItems = extractBullets(rawMarkdown, 'Action Items for Tomorrow');
  const blockers = extractBullets(rawMarkdown, 'Open Questions / Blockers');

  return {
    accomplishments,
    actionItems,
    blockers,
    rawMarkdown,
  };
}

function extractBullets(text, sectionTitle) {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`##\\s*${escaped}[\\s\\S]*?(?=\\n##|$)`, 'i');
  const match = text.match(pattern);
  if (!match) return [];

  const bullets = [];
  const lines = match[0].split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const item = trimmed.slice(2).trim();
      if (item && item.toLowerCase() !== 'none') {
        bullets.push(item);
      }
    }
  }
  return bullets;
}
