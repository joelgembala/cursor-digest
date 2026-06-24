#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTranscripts } from './lib/transcript-parser.mjs';
import { summarizeDaily, summarizeWeekly, generateStories } from './lib/summarizer.mjs';
import { createTasks, loadPendingTasks, savePendingTasks, setupAuth } from './lib/ms-todo.mjs';
import { writeDailyReport, writeWeeklyReport, readDailySummaries, getISOWeekString } from './lib/report-writer.mjs';
import { fetchSpaceMessages, listSpaces, setupOAuth } from './lib/webex-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const raw = readFileSync(resolve(__dirname, 'config.json'), 'utf-8');
  const config = JSON.parse(raw);
  config.reports.outputDir = config.reports.outputDir.replace(/^~/, process.env.HOME);
  return config;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let mode = null;
  let dryRun = false;
  let setupTodo = false;
  let setupWebex = false;
  let listWebexSpaces = false;

  for (const arg of args) {
    if (arg === '--setup-todo') setupTodo = true;
    else if (arg === '--setup-webex') setupWebex = true;
    else if (arg === '--list-spaces') listWebexSpaces = true;
    else if (arg === '--mode=daily' || arg === '--mode daily') mode = 'daily';
    else if (arg === '--mode=weekly' || arg === '--mode weekly') mode = 'weekly';
    else if (arg === 'daily') mode = mode || 'daily';
    else if (arg === 'weekly') mode = mode || 'weekly';
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--mode=')) mode = arg.split('=')[1];
  }

  if (setupTodo) return { mode: null, dryRun, setupTodo, setupWebex: false, listWebexSpaces: false };
  if (setupWebex) return { mode: null, dryRun, setupTodo: false, setupWebex: true, listWebexSpaces: false };
  if (listWebexSpaces) return { mode: null, dryRun, setupTodo: false, setupWebex: false, listWebexSpaces: true };

  if (!mode) {
    console.error('Usage: digest.mjs --mode <daily|weekly> [--dry-run]');
    console.error('       digest.mjs --setup-todo');
    console.error('       digest.mjs --setup-webex');
    console.error('       digest.mjs --list-spaces');
    process.exit(1);
  }

  if (mode !== 'daily' && mode !== 'weekly') {
    console.error(`Invalid mode: "${mode}". Must be "daily" or "weekly".`);
    process.exit(1);
  }

  return { mode, dryRun, setupTodo, setupWebex: false, listWebexSpaces: false };
}

function getDateRange(mode) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (mode === 'daily') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { start: today, end: tomorrow };
  }

  const dayOfWeek = today.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(monday.getDate() + mondayOffset);

  const saturday = new Date(monday);
  saturday.setDate(saturday.getDate() + 5);

  return { start: monday, end: saturday };
}

function getNextBusinessDay() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  next.setDate(next.getDate() + 1);

  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function buildDryRunDailySummary(transcripts, dateStr) {
  const accomplishments = [];
  const actionItems = [];
  for (const t of transcripts) {
    for (const q of t.userQueries.slice(0, 3)) {
      accomplishments.push(q.length > 100 ? q.slice(0, 100) + '...' : q);
    }
  }
  if (accomplishments.length > 0) {
    actionItems.push('Review and continue work from today\'s sessions');
  }
  const rawMarkdown = `## What I Accomplished Today\n${accomplishments.map((a) => `- ${a}`).join('\n')}\n\n## Action Items for Tomorrow\n${actionItems.map((a) => `- ${a}`).join('\n')}\n\n## Open Questions / Blockers\n- None (dry-run)\n`;
  return { accomplishments, actionItems, blockers: [], rawMarkdown };
}

async function runDaily(config, dryRun) {
  const { start, end } = getDateRange('daily');
  const dateStr = start.toISOString().slice(0, 10);
  console.log(`[daily] Scanning transcripts for ${dateStr}`);

  const transcripts = await parseTranscripts(config, start, end);
  console.log(`[daily] Found ${transcripts.length} transcript(s).`);

  let webexMessages = [];
  if (config.webex?.spaces?.length > 0) {
    console.log('[daily] Fetching Webex messages...');
    webexMessages = await fetchSpaceMessages(config, start, end);
    const msgCount = webexMessages.reduce((sum, s) => sum + s.messages.length, 0);
    console.log(`[daily] Found ${msgCount} Webex message(s) across ${webexMessages.length} space(s).`);
  }

  if (transcripts.length === 0 && webexMessages.length === 0) {
    console.log('[daily] No transcripts or Webex messages found for today. Nothing to summarize.');
    return;
  }

  let summary;
  if (dryRun) {
    console.log('[daily] [dry-run] Skipping Circuit API -- using transcript excerpts as mock summary.');
    summary = buildDryRunDailySummary(transcripts, dateStr);
  } else {
    console.log('[daily] Summarizing via Circuit API...');
    summary = await summarizeDaily(config, transcripts, webexMessages, dateStr);
  }

  console.log('[daily] Writing daily report...');
  await writeDailyReport(config, dateStr, summary);

  const dueDate = getNextBusinessDay();
  const pending = loadPendingTasks(config);
  let allFailed = [];

  if (pending.length > 0 && !dryRun) {
    console.log(`[daily] Retrying ${pending.length} pending task(s) from previous runs...`);
    const pendingTitles = pending.map((p) => p.title);
    const pendingDueDate = pending[0].dueDate ? new Date(pending[0].dueDate) : dueDate;
    try {
      const result = await createTasks(config, pendingTitles, pendingDueDate);
      allFailed.push(...result.failed);
    } catch (err) {
      console.error(`[daily] Warning: Pending tasks retry failed (non-fatal): ${err.message}`);
      allFailed.push(...pending);
    }
  }

  if (summary.actionItems && summary.actionItems.length > 0) {
    if (dryRun) {
      console.log('[daily] [dry-run] Would create tasks:');
      for (const item of summary.actionItems) {
        console.log(`  - ${item}`);
      }
    } else {
      console.log(`[daily] Creating ${summary.actionItems.length} task(s) in "${config.todo.listName}"...`);
      try {
        const result = await createTasks(config, summary.actionItems, dueDate);
        allFailed.push(...result.failed);
      } catch (err) {
        console.error(`[daily] Warning: To Do tasks failed (non-fatal): ${err.message}`);
        console.error('[daily] The daily report was still saved successfully.');
        allFailed.push(...summary.actionItems.map((title) => ({ title, dueDate: dueDate.toISOString() })));
      }
    }
  }

  if (!dryRun) {
    savePendingTasks(config, allFailed);
    if (allFailed.length > 0) {
      console.log(`[daily] Saved ${allFailed.length} failed task(s) for retry on next run.`);
    }
  }

  console.log('[daily] Done.');
}

function buildDryRunWeeklyReport(dailySummaries, transcripts, weekStart, weekEnd) {
  let body;
  if (dailySummaries && dailySummaries.length > 0) {
    body = dailySummaries.map((s) => `**${s.date}.** ${s.content.split('\n').filter((l) => l.startsWith('- ')).slice(0, 2).map((l) => l.slice(2)).join('. ')}`).join('\n\n');
  } else if (transcripts && transcripts.length > 0) {
    const items = transcripts.flatMap((t) => t.userQueries.slice(0, 2));
    body = items.map((q) => `- ${q.length > 100 ? q.slice(0, 100) + '...' : q}`).join('\n');
  } else {
    body = '*No activity recorded.*';
  }
  const markdown = `# Week of ${weekStart} to ${weekEnd}\n\n(dry-run placeholder — this section would be a 2-3 sentence summary of the week)\n\n## What Moved Forward\n\n${body}\n\n## Where I Need Help\n\nNothing blocking right now. (dry-run)\n\n## Coming Up Next Week\n\n- Review carry-over items from this week\n`;
  return { markdown };
}

async function runWeekly(config, dryRun) {
  const { start, end } = getDateRange('weekly');
  const weekStart = start.toISOString().slice(0, 10);
  const weekEnd = new Date(end.getTime() - 86400000).toISOString().slice(0, 10);
  console.log(`[weekly] Generating report for week of ${weekStart} to ${weekEnd}`);

  const dailySummaries = await readDailySummaries(config, start, end);
  let transcripts = null;
  let webexMessages = [];

  if (dailySummaries.length === 0) {
    console.log('[weekly] No daily summaries found for this week. Falling back to raw transcripts...');
    transcripts = await parseTranscripts(config, start, end);

    if (config.webex?.spaces?.length > 0) {
      console.log('[weekly] Fetching Webex messages for the week...');
      webexMessages = await fetchSpaceMessages(config, start, end);
      const msgCount = webexMessages.reduce((sum, s) => sum + s.messages.length, 0);
      console.log(`[weekly] Found ${msgCount} Webex message(s) across ${webexMessages.length} space(s).`);
    }

    if (transcripts.length === 0 && webexMessages.length === 0) {
      console.log('[weekly] No transcripts or Webex messages found. Nothing to report.');
      return;
    }
    console.log(`[weekly] Found ${transcripts.length} transcript(s).`);
  } else {
    console.log(`[weekly] Found ${dailySummaries.length} daily summaries.`);
  }

  let report;
  if (dryRun) {
    console.log('[weekly] [dry-run] Skipping Circuit API -- using raw data as mock report.');
    report = buildDryRunWeeklyReport(dailySummaries, transcripts, weekStart, weekEnd);
    console.log('[weekly] [dry-run] Preview:');
    console.log(report.markdown.slice(0, 600));
  } else {
    console.log('[weekly] Synthesizing via Circuit API...');
    if (dailySummaries.length > 0) {
      report = await summarizeWeekly(config, dailySummaries, null, null, weekStart, weekEnd);
    } else {
      report = await summarizeWeekly(config, null, transcripts, webexMessages, weekStart, weekEnd);
    }
    await writeWeeklyReport(config, start, report);
  }

  if (config.jira) {
    console.log('[weekly] Generating Jira user stories from Next Week Plan...');
    let newStories;
    if (dryRun) {
      newStories = [
        { summary: 'Review carry-over items from this week', description: 'Dry-run placeholder story.', storyPoints: 1 },
      ];
    } else {
      newStories = await generateStories(config, report.markdown);
    }

    if (newStories.length > 0) {
      const outputDir = config.reports.outputDir.replace(/^~/, process.env.HOME);
      const storiesDir = join(outputDir, 'weekly');
      mkdirSync(storiesDir, { recursive: true });

      const isoWeek = getISOWeekString(start);
      const storiesPath = join(storiesDir, `stories-${isoWeek}.json`);

      const enriched = newStories.map((s) => ({
        id: randomUUID().slice(0, 8),
        ...s,
        status: 'pending',
      }));

      let mergedStories = enriched;
      if (existsSync(storiesPath)) {
        try {
          const existing = JSON.parse(readFileSync(storiesPath, 'utf-8'));
          const created = (existing.stories || []).filter((s) => s.status === 'created');
          if (created.length > 0) {
            console.log(`  [jira] Preserving ${created.length} already-created story/stories from previous run.`);
            mergedStories = [...created, ...enriched];
          }
        } catch {
          console.log('  [jira] Could not parse existing stories file; overwriting.');
        }
      }

      const payload = {
        generatedAt: new Date().toISOString(),
        weekOf: weekStart,
        projectKey: config.jira.projectKey,
        assignee: config.jira.assignee,
        stories: mergedStories,
      };
      writeFileSync(storiesPath, JSON.stringify(payload, null, 2), 'utf-8');
      const pendingCount = mergedStories.filter((s) => s.status === 'pending').length;
      console.log(`  [jira] Saved ${pendingCount} pending stories to ${storiesPath}`);
      console.log('  [jira] To push these to Jira, open Cursor and say: "Create my weekly Jira stories"');
    } else {
      console.log('[weekly] No stories generated from the weekly plan.');
    }
  }

  if (!dryRun) {
    const fmtOpts = { month: 'short', day: 'numeric' };
    const startLabel = start.toLocaleDateString('en-US', fmtOpts);
    const endLabel = new Date(end.getTime() - 86400000).toLocaleDateString('en-US', fmtOpts);
    const taskTitle = `Weekly digest ready (${startLabel}–${endLabel}) — review report and fill out teamspace check-in`;
    console.log('[weekly] Creating reminder task in Microsoft To Do...');
    try {
      await createTasks(config, [taskTitle], new Date());
    } catch (err) {
      console.error(`[weekly] Failed to create reminder task: ${err.message}`);
    }
  }

  console.log('[weekly] Done.');
}

async function runListSpaces() {
  console.log('[webex] Fetching your Webex spaces...\n');
  const spaces = await listSpaces();
  if (spaces.length === 0) {
    console.log('No spaces found.');
    return;
  }
  console.log('Add the spaces you want tracked to config.json under "webex.spaces":\n');
  for (const s of spaces) {
    const age = s.lastActivity ? ` (last active: ${s.lastActivity.slice(0, 10)})` : '';
    console.log(`  ${s.type === 'direct' ? '[DM]  ' : '[Room]'} ${s.title}${age}`);
    console.log(`         id: "${s.id}"\n`);
  }
  console.log('Example config.json entry:');
  console.log('  "webex": { "spaces": [{ "id": "<paste-id>", "name": "My Team" }] }');
}

async function main() {
  const { mode, dryRun, setupTodo, setupWebex, listWebexSpaces } = parseArgs();
  const config = loadConfig();

  if (setupTodo) {
    try {
      await setupAuth(config);
    } catch (err) {
      console.error('[setup] Fatal error:', err.message);
      process.exit(1);
    }
    return;
  }

  if (setupWebex) {
    try {
      console.log('[webex] Starting OAuth authorization flow...');
      await setupOAuth(config);
      console.log('[webex] Tokens saved to .webex-tokens.json');
      console.log('[webex] Next: run "node digest.mjs --list-spaces" to find space IDs for config.json');
    } catch (err) {
      console.error('[webex] Fatal error:', err.message);
      process.exit(1);
    }
    return;
  }

  if (listWebexSpaces) {
    try {
      await runListSpaces();
    } catch (err) {
      console.error('[webex] Fatal error:', err.message);
      process.exit(1);
    }
    return;
  }

  if (!dryRun && (!process.env.BRIDGE_API_CLIENT_ID || !process.env.BRIDGE_API_CLIENT_SECRET)) {
    console.error('Error: Circuit credentials not set.');
    console.error('Required: BRIDGE_API_CLIENT_ID, BRIDGE_API_CLIENT_SECRET, BRIDGE_API_APP_KEY');
    process.exit(1);
  }

  try {
    if (mode === 'daily') {
      await runDaily(config, dryRun);
    } else {
      await runWeekly(config, dryRun);
    }
  } catch (err) {
    console.error(`[${mode}] Fatal error:`, err.message);
    process.exit(1);
  }
}

main();
