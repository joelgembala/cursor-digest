import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscripts } from '../lib/transcript-parser.mjs';
import { runDemo } from '../demo/run.mjs';

test('actual CLI produces a report from fictional input with adapters blocked', () => {
  const result = runDemo();
  assert.equal(result.reportCount, 1);
  assert.match(result.report, /Map the fictional Orchard Works onboarding handoff/);
  assert.match(result.report, /Draft an adoption checklist/);
  assert.match(result.stdout, /Skipping Circuit API/);
  assert.match(result.stdout, /dry-run/);
});
test('actual CLI does not invent a report when no input exists', () => {
  const result = runDemo({ empty: true });
  assert.equal(result.reportCount, 0);
  assert.match(result.stdout, /Nothing to summarize/);
});
test('parser tolerates a malformed line and excludes stale files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autobrief-parser-test-'));
  try {
    const base = join(dir, 'project', 'agent-transcripts');
    for (const name of ['current', 'stale', 'empty']) {
      mkdirSync(join(base, name), { recursive: true });
      const path = join(base, name, `${name}.jsonl`);
      writeFileSync(path, name === 'empty' ? '\n' : 'malformed\n' + JSON.stringify({role:'user', message:{content:[{type:'text',text:'<user_query>Fictional task for review</user_query>'}]}}));
      const date = new Date(name === 'stale' ? '2020-01-01T12:00:00Z' : '2026-01-01T12:00:00Z');
      utimesSync(path, date, date);
    }
    const records = await parseTranscripts({transcriptsBase:dir,projects:['project','missing']}, new Date('2026-01-01'), new Date('2026-01-02'));
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].userQueries, ['Fictional task for review']);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
