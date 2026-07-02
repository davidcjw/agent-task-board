#!/usr/bin/env node
// Lightweight CI guard: syntax-check every agent/**/*.mjs (excluding tests)
// via `node --check`. Prints a ✓/✗ per file and exits non-zero on any failure.
// These scripts are plain Node ESM and are otherwise untouched by lint/typecheck.

import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = dirname(fileURLToPath(import.meta.url));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(agentDir).sort();
let failed = 0;

for (const file of files) {
  const rel = relative(process.cwd(), file);
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`✓ ${rel}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${rel}`);
    const detail = err.stderr?.toString().trim();
    if (detail) console.error(detail);
  }
}

console.log(`\nChecked ${files.length} file(s), ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
