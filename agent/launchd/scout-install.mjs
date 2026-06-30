#!/usr/bin/env node
// scout-install.mjs — install/uninstall a macOS LaunchAgent that fires the
// Improvement Scout (agent/scout.mjs) every 2 hours during waking hours
// (08:00–22:00 by default, silent overnight). Each fire is a one-shot: scout
// runs, proposes the top idea on Telegram, and exits — so this uses an array of
// StartCalendarInterval entries (NOT KeepAlive/RunAtLoad). A long-sleeping loop
// would drift and die on reboot; calendar entries survive both.
//
// It does NOT run a board; the scout POSTs (on your ✅) to whatever board is
// already up (the control plane / `npm run agents`), whose Telegram bot also
// fields the Yes/No taps. Make sure that's running, or a ✅ can't be queued.
//
//   node agent/launchd/scout-install.mjs                       # every 2h, 08:00–22:00
//   node agent/launchd/scout-install.mjs --start 9 --end 21 --every 3
//   node agent/launchd/scout-install.mjs --minute 15           # fire at :15 past
//   node agent/launchd/scout-install.mjs --dry-run             # scheduled runs preview only
//   node agent/launchd/scout-install.mjs --print               # print the plist and exit
//   node agent/launchd/scout-install.mjs --uninstall           # unload + remove
//
// Or via npm: `npm run scout:install [-- --start 9]` / `npm run scout:uninstall`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LABEL = "com.davidcjw.agent-task-board.scout";
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const repoRoot = path.resolve(process.cwd());
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const uid = process.getuid();
const domain = `gui/${uid}`;

function launchctl(...a) {
  const r = spawnSync("launchctl", a, { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function uninstall() {
  launchctl("bootout", `${domain}/${LABEL}`); // no-op if not loaded — fine
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log(`✓ removed scout LaunchAgent ${LABEL}`);
}

function xml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPlist({ program, dataDir, pathEnv, times }) {
  const intervals = times
    .map(
      (t) =>
        `    <dict>\n      <key>Hour</key>\n      <integer>${t.hour}</integer>\n` +
        `      <key>Minute</key>\n      <integer>${t.minute}</integer>\n    </dict>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathEnv)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>StandardOutPath</key>
  <string>${xml(path.join(dataDir, "scout.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(dataDir, "scout.err.log"))}</string>
</dict>
</plist>
`;
}

function install() {
  // Active window: fire every `--every` hours from `--start` to `--end` (inclusive)
  // at `--minute` past. Default: every 2h, 08:00–22:00 — silent 23:00–07:00.
  const minute = Math.max(0, Math.min(59, Number(val("--minute", "0")) || 0));
  const start = Math.max(0, Math.min(23, Number(val("--start", "8")) || 0));
  const end = Math.max(0, Math.min(23, Number(val("--end", "22")) || 0));
  const every = Math.max(1, Math.min(24, Number(val("--every", "2")) || 1));
  const times = [];
  for (let h = start; h <= end; h += every) times.push({ hour: h, minute });
  // Flags forwarded verbatim to scout.mjs.
  const passthrough = ["--dry-run"].filter(has);
  const dataDir = path.join(repoRoot, ".data");

  const program = [
    process.execPath, // absolute node path (handles nvm)
    "--env-file-if-exists=.env",
    "agent/scout.mjs",
    ...passthrough,
  ];
  // launchd gives a minimal PATH; widen it so the scan can find `claude`, etc.
  const pathEnv = [
    path.dirname(process.execPath),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");

  const plist = buildPlist({ program, dataDir, pathEnv, times });

  if (has("--print")) {
    console.log(plist);
    return;
  }

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);
  // Reload cleanly: boot out an old copy first (ignore failure), then bootstrap.
  launchctl("bootout", `${domain}/${LABEL}`);
  const r = launchctl("bootstrap", domain, plistPath);
  if (r.code !== 0) {
    console.error(`✗ launchctl bootstrap failed:\n${r.out.trim()}`);
    console.error(`  Plist written to ${plistPath} — load it manually or re-run.`);
    process.exit(1);
  }
  const mm = String(minute).padStart(2, "0");
  const when = times.map((t) => `${String(t.hour).padStart(2, "0")}:${mm}`).join(", ");
  console.log(`✓ installed scout LaunchAgent ${LABEL} — fires at ${when}${has("--dry-run") ? " (dry-run)" : ""}`);
  console.log(`  plist: ${plistPath}`);
  console.log(`  logs:  ${path.join(dataDir, "scout.{out,err}.log")}`);
  console.log(`  needs a board + Telegram bot running (npm run agents / control plane) to accept your ✅.`);
}

if (process.platform !== "darwin") {
  console.error("LaunchAgents are macOS-only. Schedule agent/scout.mjs with cron/systemd elsewhere.");
  process.exit(1);
}

if (has("--uninstall")) uninstall();
else install();
