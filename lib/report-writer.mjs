import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function resolveOutputDir(config) {
  return config.reports.outputDir.replace(/^~/, process.env.HOME);
}

/**
 * Write a daily summary report as a markdown file.
 */
export async function writeDailyReport(config, dateStr, summary) {
  const dir = join(resolveOutputDir(config), 'daily');
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${dateStr}.md`);
  writeFileSync(filePath, summary.rawMarkdown, 'utf-8');
  console.log(`  [report] Daily summary written to ${filePath}`);
}

/**
 * Write a weekly report as a markdown file.
 */
export async function writeWeeklyReport(config, weekStartDate, report) {
  const dir = join(resolveOutputDir(config), 'weekly');
  mkdirSync(dir, { recursive: true });

  const isoWeek = getISOWeekString(weekStartDate);
  const filePath = join(dir, `${isoWeek}.md`);
  writeFileSync(filePath, report.markdown, 'utf-8');
  console.log(`  [report] Weekly report written to ${filePath}`);
}

/**
 * Read all daily summaries that fall within the given date range.
 * Returns array of { date: string, content: string }.
 */
export async function readDailySummaries(config, start, end) {
  const dir = join(resolveOutputDir(config), 'daily');
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  const summaries = [];
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const dateStr = file.replace('.md', '');
    if (dateStr >= startStr && dateStr < endStr) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        summaries.push({ date: dateStr, content });
      } catch {
        continue;
      }
    }
  }

  summaries.sort((a, b) => a.date.localeCompare(b.date));
  return summaries;
}

export function getISOWeekString(date) {
  const year = date.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const dayOfYear = Math.ceil((date - jan1) / 86400000) + 1;
  const weekNum = Math.ceil((dayOfYear + jan1.getDay()) / 7);
  const paddedWeek = String(weekNum).padStart(2, '0');
  return `${year}-W${paddedWeek}`;
}
