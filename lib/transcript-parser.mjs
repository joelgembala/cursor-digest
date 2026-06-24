import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Scan configured project directories for JSONL transcripts modified within
 * the given date range, then extract user queries and assistant action summaries.
 *
 * @param {object} config  - Loaded config.json
 * @param {Date}   start   - Inclusive start of window
 * @param {Date}   end     - Exclusive end of window
 * @returns {Array<{sessionId: string, project: string, timestamp: Date, userQueries: string[], assistantActions: string[]}>}
 */
export async function parseTranscripts(config, start, end) {
  const results = [];

  for (const project of config.projects) {
    const transcriptsDir = join(config.transcriptsBase, project, 'agent-transcripts');
    let entries;
    try {
      entries = readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionId = entry.name;
      const jsonlPath = join(transcriptsDir, sessionId, `${sessionId}.jsonl`);

      let stat;
      try {
        stat = statSync(jsonlPath);
      } catch {
        continue;
      }

      if (stat.mtime < start || stat.mtime >= end) continue;

      try {
        const parsed = parseJsonlFile(jsonlPath, sessionId, project, stat.mtime);
        if (parsed) results.push(parsed);
      } catch {
        continue;
      }
    }
  }

  results.sort((a, b) => a.timestamp - b.timestamp);
  return results;
}

function parseJsonlFile(filePath, sessionId, project, mtime) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  const userQueries = [];
  const assistantActions = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.role === 'user') {
      const queries = extractUserQueries(entry);
      userQueries.push(...queries);
    } else if (entry.role === 'assistant') {
      const actions = extractAssistantActions(entry);
      assistantActions.push(...actions);
    }
  }

  if (userQueries.length === 0 && assistantActions.length === 0) return null;

  return {
    sessionId,
    project,
    timestamp: mtime,
    userQueries,
    assistantActions,
  };
}

function extractUserQueries(entry) {
  const queries = [];
  const contentBlocks = entry.message?.content || [];

  for (const block of contentBlocks) {
    if (block.type !== 'text') continue;
    const text = block.text || '';

    const tagPattern = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/g;
    let match;
    while ((match = tagPattern.exec(text)) !== null) {
      const query = match[1].trim();
      if (query) queries.push(query);
    }

    if (queries.length === 0 && text.length > 0 && text.length < 2000) {
      const cleaned = text
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned.length > 10) queries.push(cleaned);
    }
  }

  return queries;
}

function extractAssistantActions(entry) {
  const actions = [];
  const contentBlocks = entry.message?.content || [];

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      const text = (block.text || '').trim();
      if (!text) continue;

      const condensed = text.length > 300 ? text.slice(0, 300) + '...' : text;
      actions.push(condensed);
    } else if (block.type === 'tool_use') {
      const toolName = block.name || 'unknown_tool';
      const inputSummary = summarizeToolInput(toolName, block.input);
      actions.push(`[tool: ${toolName}] ${inputSummary}`);
    }
  }

  return actions;
}

function summarizeToolInput(toolName, input) {
  if (!input) return '';

  if (toolName === 'Shell' || toolName === 'Bash') {
    return `command: ${truncate(input.command || '', 120)}`;
  }
  if (toolName === 'Read') {
    return `read: ${input.path || ''}`;
  }
  if (toolName === 'Write') {
    return `wrote: ${input.path || ''}`;
  }
  if (toolName === 'StrReplace') {
    return `edited: ${input.path || ''}`;
  }
  if (toolName === 'Grep' || toolName === 'SemanticSearch') {
    return `searched: ${truncate(input.pattern || input.query || '', 80)}`;
  }
  if (toolName === 'Glob') {
    return `glob: ${input.glob_pattern || ''}`;
  }
  if (toolName === 'Task') {
    return `subagent: ${truncate(input.description || '', 80)}`;
  }

  const keys = Object.keys(input).slice(0, 3).join(', ');
  return `params: ${keys}`;
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}
