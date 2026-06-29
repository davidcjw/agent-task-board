#!/usr/bin/env node
// scout-install.mjs — install/uninstall a macOS LaunchAgent that fires the
// Improvement Scout (agent/scout.mjs) once a day at a set time (10pm default).
// Unlike the control-plane agent this is a one-shot: it runs, pushes the top
// idea, and exits — so it uses StartCalendarInterval (NOT KeepAlive/RunAtLoad).
//
// It does NOT run a board; it POSTs the queued task to whatever board is already
// up (the control plane / `npm run agents`). Make sure that's running at the
// scheduled time, or the push will fail (the scout logs + Telegrams the error).
//
//   node agent/launchd/scout-install.mjs                 # install at 22:00
//   node agent/launchd/scout-install.mjs --hour 21 --minute 30
//   node agent/launchd/scout-install.mjs --dry-run       # scheduled run previews only
//   node agent/launchd/scout-install.mjs --print         # print the plist and exit
//   node agent/launchd/scout-install.mjs --uninstall     # unload + remove
//
// Or via npm: `npm run scout:install [-- --hour 21]` / `npm run scout:uninstall`.

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

function buildPlist({ program, dataDir, pathEnv, hour, minute }) {
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
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(path.join(dataDir, "scout.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(dataDir, "scout.err.log"))}</string>
</dict>
</plist>
`;
}

function install() {
  const hour = Math.max(0, Math.min(23, Number(val("--hour", "22")) || 0));
  const minute = Math.max(0, Math.min(59, Number(val("--minute", "0")) || 0));
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

  const plist = buildPlist({ program, dataDir, pathEnv, hour, minute });

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
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  console.log(`✓ installed scout LaunchAgent ${LABEL} — fires daily at ${hh}:${mm}${has("--dry-run") ? " (dry-run)" : ""}`);
  console.log(`  plist: ${plistPath}`);
  console.log(`  logs:  ${path.join(dataDir, "scout.{out,err}.log")}`);
  console.log(`  needs a board running at that time (npm run agents / control plane) to accept the queued task.`);
}

if (process.platform !== "darwin") {
  console.error("LaunchAgents are macOS-only. Schedule agent/scout.mjs with cron/systemd elsewhere.");
  process.exit(1);
}

if (has("--uninstall")) uninstall();
else install();
