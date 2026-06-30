#!/usr/bin/env node
// Improvement Scout — scans every repo under ~/code, asks an agent to brainstorm
// and SCORE improvements (infra, dev tools, features, fixes — even a brand-new
// project if the win is big enough), ranks them all by ICE score, and PROPOSES
// only the single highest-ranked idea to you on Telegram with Yes/No buttons.
// It queues the task only if you tap ✅; tap ❌ (or ignore it) and nothing runs.
//
// Runs once and exits — meant to fire every 2h during waking hours via launchd
// (see agent/launchd/scout-install.mjs) or by hand. While a proposal is still
// awaiting your answer it pauses (skips the scan); after a 24h TTL the next run
// dismisses the stale proposal and scans afresh. The pending offer is parked in
// .data/scout-pending.json; the control-plane Telegram bot acts on your tap.
// Needs a board up (npm run agents / the control plane) to accept a ✅.
// Without Telegram configured it falls back to pushing straight to the board.
//
// Usage:
//   node agent/scout.mjs                # scan → rank → propose the top idea
//   node agent/scout.mjs --dry-run      # scan → rank → print, but propose nothing
//   node agent/scout.mjs --print-prompt # print the scan prompt and exit
//
// Env: AGENT_REPO_BASE (default ~/code), SCOUT_MODEL, SCOUT_TIMEOUT (ms),
//      BOARD_URL / AGENT_TOKEN (board client), TELEGRAM_* (notifications).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addTask } from "./lib/api.mjs";
import { clearPending, readPending, writePending } from "./lib/pending.mjs";
import { listRepos, REPO_BASE } from "./lib/repos.mjs";
import {
  acceptedKeySet,
  avoidTitles,
  dropIdea,
  dueForFullScan,
  readMemory,
  recordAccepted,
  recordScan,
  repoFingerprints,
  reposToScan,
  setBacklog,
  topIdea,
  writeMemory,
} from "./lib/scout-memory.mjs";
import {
  ideaToTask,
  mergeBacklog,
  parseScout,
  proposalActive,
  proposalKeyboard,
  proposalText,
  rankIdeas,
  scoutSummary,
} from "./lib/scout.mjs";
import { normalizeRepoKey, repoFromTags } from "./lib/routes.mjs";
import { editMessageText, sendMessage, telegramEnabled } from "./lib/telegram.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const DRY_RUN = has("--dry-run");
const FULL = has("--full"); // ignore the memory ledger and scan every repo
const MODEL = process.env.SCOUT_MODEL || "";
const TIMEOUT = Number(process.env.SCOUT_TIMEOUT || "1800000"); // 30 min — scanning many repos is slow
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

async function notify(text) {
  if (telegramEnabled() && CHAT_ID) await sendMessage(CHAT_ID, text);
}

function scoutPrompt(repos, avoid = []) {
  const list = repos.length ? repos.map((r) => `- ${r}`).join("\n") : "(none found)";
  const avoidBlock = avoid.length
    ? [
        "",
        "These ideas are already known (queued or previously proposed) — do NOT",
        "repeat them; if a repo still has room, find a different, fresh angle:",
        ...avoid.map((t) => `- ${t}`),
      ].join("\n")
    : "";
  return [
    "You are an autonomous improvement scout for a developer's project folder.",
    `The current directory is the root of that folder. Survey ONLY these projects`,
    `(the rest are unchanged since the last scan — ignore them):`,
    "",
    list,
    avoidBlock,
    "",
    "For each, look at the README, the code structure, recent",
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
  console.log(`🔭 scout · base=${REPO_BASE} · ${repos.length} repos · ${DRY_RUN ? "dry-run" : "will propose top idea"}`);

  if (has("--print-prompt")) {
    console.log(scoutPrompt(repos, avoidTitles(readMemory())));
    return;
  }
  if (!repos.length) {
    console.warn(`No repos found under ${REPO_BASE} — nothing to scout.`);
    return;
  }

  // Pause-until-answered: if a prior proposal is still within its TTL, don't
  // scan again — wait for your Yes/No so unanswered ideas never pile up. Once
  // it's expired, dismiss it (stamp the old message) and scan afresh.
  if (!DRY_RUN) {
    const pending = readPending();
    if (proposalActive(pending, Date.now())) {
      console.log("⏸ a scout idea is still awaiting your Yes/No — skipping this scan.");
      return;
    }
    if (pending) {
      clearPending();
      if (pending.chatId && pending.messageId) {
        await editMessageText(
          pending.chatId,
          pending.messageId,
          `${pending.text || ""}\n\n⏱ Expired unanswered — dismissed.`,
        );
      }
      await notify("⏱ Previous scout idea expired unanswered — dismissed. Scanning afresh.");
    }
  }

  // Incremental scan: fingerprint every repo (HEAD sha, +dirty on uncommitted
  // changes) and deep-scan only those that moved or are new — skipping unchanged
  // repos is the cost saving. A periodic full sweep (or --full) rebuilds the
  // backlog from scratch so a stale ledger can't permanently hide a repo.
  const now = Date.now();
  let memory = readMemory();
  const fingerprints = await repoFingerprints(repos);
  const full = FULL || dueForFullScan(memory, now);
  const { scan, skipped } = full ? { scan: repos, skipped: [] } : reposToScan(repos, fingerprints, memory);
  console.log(
    `📒 memory · ${scan.length} to scan, ${skipped.length} unchanged${full ? " · full sweep" : ""} · backlog ${memory.ideas.length}`,
  );

  // Scan the changed repos (if any) and fold their fresh ideas into the ranked
  // backlog, deduped against what we already hold and already proposed. When
  // nothing changed we skip the model entirely and just propose from the backlog.
  if (scan.length) {
    console.log("scanning… (this can take a while)");
    const { text, error } = await runScan(scoutPrompt(scan, avoidTitles(memory)));
    if (error) {
      console.error(`✗ scan failed: ${error}`);
      await notify(`🔭 Scout failed to scan: ${error}`);
      process.exitCode = 1;
      return;
    }

    const { ideas } = parseScout(text);
    const fresh = rankIdeas(ideas);
    if (!fresh.length) {
      // parseScout failed closed — persist the raw scan text so a recurrence is
      // diagnosable (the model may have wrapped/truncated the JSON or returned
      // nothing). We still fall through to propose from the existing backlog.
      let savedTo = "";
      try {
        const file = path.join(process.cwd(), ".data", "scout-last-scan.txt");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
        savedTo = file;
      } catch {
        /* best-effort — don't let logging failure mask the real outcome */
      }
      const preview = text.slice(0, 500).replace(/\s+/g, " ").trim();
      console.warn(
        `No actionable ideas parsed from the scan (${text.length} chars of model output).` +
          (savedTo ? ` Raw output saved to ${savedTo}.` : "") +
          (preview ? `\n  preview: ${preview}${text.length > 500 ? "…" : ""}` : " (empty output)"),
      );
    }

    // Fresh ideas for a just-scanned repo supersede that repo's stale backlog
    // entries; a full sweep rebuilds from the fresh scan alone.
    const scannedKeys = new Set(scan.map(normalizeRepoKey));
    const backlog = mergeBacklog(full ? [] : memory.ideas, fresh, {
      scannedKeys,
      acceptedKeys: acceptedKeySet(memory),
    });
    memory = recordScan(setBacklog(memory, backlog), { scanned: scan, fingerprints, now, full });
    if (!DRY_RUN) writeMemory(memory);
  } else {
    console.log("⏭ no repos changed — proposing from the existing backlog (no scan).");
  }

  // Propose the best idea we hold — fresh from this scan or carried over from an
  // earlier one (the #2–#5 a prior run ranked but didn't pitch).
  const top = topIdea(memory);
  if (!top) {
    console.log("Scout has no ideas to propose right now (empty backlog).");
    if (scan.length) await notify("🔭 Scout ran but found no actionable improvements this time.");
    return;
  }

  const summary = scoutSummary(memory.ideas, top);
  console.log(`\n${summary}\n`);

  const task = ideaToTask(top, { knownRepos: repos, repoBase: REPO_BASE });
  // The ledger keys repos by the resolved `repo:` tag (normalized dir name) — ""
  // for workspace/new-project ideas.
  const taskRepo = repoFromTags(task.tags);

  if (DRY_RUN) {
    console.log("[dry-run] not proposing. Top idea task input:");
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  // Without Telegram there's nothing to confirm against — fall back to pushing
  // straight to the board (the original behavior) so scout still works headless.
  if (!telegramEnabled() || !CHAT_ID) {
    console.warn("Telegram not configured — queuing directly, no confirmation.");
    try {
      const created = await addTask(task);
      // Direct-queue is an immediate accept → record it so it's never re-proposed.
      writeMemory(recordAccepted(memory, top.key, { repo: taskRepo, title: top.title, now }));
      console.log(`✓ queued task ${created.id} — "${created.title}"`);
    } catch (e) {
      console.error(`✗ failed to push task: ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }

  // Propose it: send the ranked summary with Yes/No buttons and park the task as
  // the single pending proposal. The control-plane bot queues it only on a ✅ tap.
  const id = Date.now().toString(36);
  const body = proposalText(summary);
  const sent = await sendMessage(CHAT_ID, body, { replyMarkup: proposalKeyboard(id) });
  if (!sent) {
    console.error("✗ couldn't send the Telegram proposal — not parking it.");
    process.exitCode = 1;
    return;
  }
  writePending({
    id,
    createdAt: Date.now(),
    chatId: String(CHAT_ID),
    messageId: sent.message_id,
    task,
    text: body,
    ideaKey: top.key,
  });
  // Drop it from the backlog so a quiet run advances to the next idea — but do NOT
  // record it accepted: only a ✅ does that (the bot), so a ❌/ignore lets a later
  // scan resurface it.
  writeMemory(dropIdea(memory, top.key));
  console.log(`📨 proposed "${top.title}" — awaiting your Yes/No (id ${id}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
