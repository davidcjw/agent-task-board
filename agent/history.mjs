#!/usr/bin/env node
// history — read the dispatcher's run-history log (.data/history.jsonl) and print
// a summary. `--json` dumps the raw summary object. Zero-state safe: an empty or
// absent log prints a clean "no runs recorded yet" without crashing.

import { readHistory, summarizeHistory } from "./lib/history.mjs";

const asJson = process.argv.slice(2).includes("--json");

const records = readHistory();
const summary = summarizeHistory(records);

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (summary.total === 0) {
  console.log("No runs recorded yet (.data/history.jsonl is empty or absent).");
  process.exit(0);
}

const pct = (r) => `${Math.round(r * 100)}%`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const table = (obj) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `    ${k}: ${v}`)
    .join("\n");

console.log(`Run history — ${summary.total} run(s)`);
console.log(`  success rate:   ${pct(summary.successRate)}`);
console.log(`  avg duration:   ${secs(summary.avgDurationMs)}`);
console.log(`  by status:\n${table(summary.byStatus)}`);
console.log(`  by repo:\n${table(summary.byRepo)}`);
console.log(`  by agent:\n${table(summary.byAgent)}`);
