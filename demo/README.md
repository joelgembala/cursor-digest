# Demonstration evidence

Executed September 25, 2026 Pacific / September 26 UTC using Node.js and the CLI from baseline `dff603a758cfa22134df7ef2626d87915e7b4804`. The production CLI and adapter files were unchanged for this demonstration.

- Input: `fictional-session.jsonl`, written for this public example.
- Execution: `npm run demo` calls the actual parser, daily dry-run formatter and report writer in an isolated temporary directory.
- Output: `output.md`, with an explanatory preface followed by actual generated Markdown.
- Checks: three tests passed, covering the normal demo, no-input result, and malformed/stale/missing input handling.
- Boundary: no model calls, live ingestion, task delivery, Jira publication or scheduling were exercised. The fetch guard covers the current adapters, not arbitrary future networking libraries.

Run `npm test` and `npm run demo` to reproduce. The scan date changes with the run date.
