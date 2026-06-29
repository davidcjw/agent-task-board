#!/usr/bin/env node
// Improvement Scout — scans every repo under ~/code, asks an agent to brainstorm
// and SCORE improvements (infra, dev tools, features, fixes — even a brand-new
// project if the win is big enough), ranks them all by ICE score, and pushes
// ONLY the single highest-ranked idea to the board as a queued task for the
// dispatcher to pick up.
//
// Runs once and exits — meant to fire on a schedule (10pm via launchd, see
// agent/launchd/scout-install.mjs) or by hand. It pushes by default; the board
// (npm run agents / the control plane) must be up so the task can be POSTed.
//
// Usage:
//   node agent/scout.mjs                # scan → rank → push the top idea
//   node agent/scout.mjs --dry-run      # scan → rank → print, but push nothing
//   node agent/scout.mjs --print-prompt # print the scan prompt and exit
//
// Env: AGENT_REPO_BASE (default ~/code), SCOUT_MODEL, SCOUT_TIMEOUT (ms),
//      BOARD_URL / AGENT_TOKEN (board client), TELEGRAM_* (notifications).

import { spawn } from "node:child_process";
import { addTask } from "./lib/api.mjs";
import { listRepos, REPO_BASE } from "./lib/repos.mjs";
import { ideaToTask, parseScout, rankIdeas, scoutSummary } from "./lib/scout.mjs";
import { sendMessage, telegramEnabled } from "./lib/telegram.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const DRY_RUN = has("--dry-run");
const MODEL = process.env.SCOUT_MODEL || "";
const TIMEOUT = Number(process.env.SCOUT_TIMEOUT || "1800000"); // 30 min — scanning many repos is slow
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

async function notify(text) {
  if (telegramEnabled() && CHAT_ID) await sendMessage(CHAT_ID, text);
}

function scoutPrompt(repos) {
  const list = repos.length ? repos.map((r) => `- ${r}`).join("\n") : "(none found)";
  return [
    "You are an autonomous improvement scout for a developer's project folder.",
    `The current directory is the root of that folder; it contains these projects:`,
    "",
    list,
    "",
    "Survey the projects. For each, look at the README, the code structure, recent",
    "git history, TODOs/FIXMEs, test coverage, tooling/CI config, and dependency",
    "health. Brainstorm concrete, high-leverage improvements across these kinds:",
    "infra, devtools, feature, fix, docs. You MAY also propose a brand-new project",
    "(its own new folder) — but only when it would be a genuinely large win.",
    "",
    "List AS MANY distinct ideas as you find worthwhile, then score EACH one on",
    "three axes, integers 1-10:",
    "  - impact: how much value it delivers to the overall ~/code workspace",
    "  - confidence: how sure you are it's worth doing and will work",
    "  - ease: how easy/low-effort it is (10 = trivial, 1 = huge effort)",
    "",
    "For each idea write a `prompt`: a precise, self-contained instruction a coding",
    "agent can execute end-to-end with no further context (state files, commands,",
    "and the definition of done). Set `repo` to the EXACT folder name from the list",
    "above for an existing project, or a short kebab-case name for a brand-new one.",
    "",
    "Output ONLY a single JSON object in a ```json code block, no prose after it:",
    "```json",
    '{ "ideas": [',
    '  { "title": "...", "repo": "<folder-or-new-name>", "category": "infra|devtools|feature|fix|docs|new-project",',
    '    "impact": 1-10, "confidence": 1-10, "ease": 1-10, "rationale": "one line", "prompt": "full task for a coding agent" }',
    "] }",
    "```",
  ].join("\n");
}

// Run `claude -p <prompt>` in the repo base, reading its JSON output's `result`.
function runScan(prompt) {
  return new Promise((resolve) => {
    const cmdArgs = ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"];
    if (MODEL) cmdArgs.push("--model", MODEL);
    const child = spawn("claude", cmdArgs, { cwd: REPO_BASE, env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ text: "", error: `Failed to start "claude": ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let text = out.trim();
      try {
        const json = JSON.parse(out);
        if (json && typeof json.result === "string") text = json.result;
      } catch {
        /* not JSON — use raw stdout */
      }
      if (!text && code !== 0) return resolve({ text: "", error: err.trim() || `claude exited ${code}` });
      resolve({ text, error: "" });
    });
  });
}

async function main() {
  const repos = listRepos();
  console.log(`🔭 scout · base=${REPO_BASE} · ${repos.length} repos · ${DRY_RUN ? "dry-run" : "will push top idea"}`);

  const prompt = scoutPrompt(repos);
  if (has("--print-prompt")) {
    console.log(prompt);
    return;
  }
  if (!repos.length) {
    console.warn(`No repos found under ${REPO_BASE} — nothing to scout.`);
    return;
  }

  console.log("scanning… (this can take a while)");
  const { text, error } = await runScan(prompt);
  if (error) {
    console.error(`✗ scan failed: ${error}`);
    await notify(`🔭 Scout failed to scan: ${error}`);
    process.exitCode = 1;
    return;
  }

  const { ideas } = parseScout(text);
  const ranked = rankIdeas(ideas);
  const top = ranked[0] || null;

  if (!top) {
    console.warn("No actionable ideas parsed from the scan.");
    await notify("🔭 Scout ran but found no actionable improvements this time.");
    return;
  }

  const summary = scoutSummary(ranked, top);
  console.log(`\n${summary}\n`);

  if (DRY_RUN) {
    console.log("[dry-run] not pushing. Top idea task input:");
    console.log(JSON.stringify(ideaToTask(top, { knownRepos: repos, repoBase: REPO_BASE }), null, 2));
    return;
  }

  try {
    const task = await addTask(ideaToTask(top, { knownRepos: repos, repoBase: REPO_BASE }));
    console.log(`✓ queued task ${task.id} — "${task.title}" [${(task.tags || []).join(", ")}]`);
    await notify(`${summary}\n\n✅ Queued to the board for the dispatcher.`);
  } catch (e) {
    console.error(`✗ failed to push task: ${e.message}`);
    await notify(`🔭 Scout picked "${top.title}" but couldn't queue it: ${e.message}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
