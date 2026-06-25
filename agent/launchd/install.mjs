#!/usr/bin/env node
// install.mjs — install/uninstall a macOS LaunchAgent that keeps the dispatcher
// running in the background: it starts at login and restarts if it crashes.
//
// This runs ONLY the dispatcher. It needs a board to talk to, so keep one up
// (run `npm run agents` in a terminal, or point BOARD_URL at a deployed board).
// Logs land in .data/dispatcher.{out,err}.log.
//
//   node agent/launchd/install.mjs             # install + load (dry-run dispatcher)
//   node agent/launchd/install.mjs --execute   # install in execute mode (runs runners)
//   node agent/launchd/install.mjs --uninstall  # unload + remove
//
// Or via npm: `npm run agents:install` / `npm run agents:install -- --execute` / `npm run agents:uninstall`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LABEL = "com.davidcjw.agent-task-board.dispatcher";
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const repoRoot = path.resolve(process.cwd());
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const uid = process.getuid();
const domain = `gui/${uid}`;

function launchctl(...a) {
  const r = spawnSync("launchctl", a, { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function uninstall() {
  // `bootout` is a no-op (non-zero) if it isn't loaded — that's fine.
  launchctl("bootout", `${domain}/${LABEL}`);
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log(`✓ removed LaunchAgent ${LABEL}`);
}

function xml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function install() {
  const execute = has("--execute");
  const dataDir = path.join(repoRoot, ".data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.dirname(plistPath), { recursive: true });

  const program = [
    process.execPath, // absolute node path (handles nvm)
    "--env-file-if-exists=.env",
    "agent/dispatcher.mjs",
    ...(execute ? ["--execute"] : []),
  ];
  // launchd gives a minimal PATH; widen it so the runner can find `claude` etc.
  const PATH = [
    path.dirname(process.execPath),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
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
    <string>${xml(PATH)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(path.join(dataDir, "dispatcher.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(dataDir, "dispatcher.err.log"))}</string>
</dict>
</plist>
`;

  writeFileSync(plistPath, plist);
  // Reload cleanly: boot out an old copy first (ignore failure), then bootstrap.
  launchctl("bootout", `${domain}/${LABEL}`);
  const r = launchctl("bootstrap", domain, plistPath);
  if (r.code !== 0) {
    console.error(`✗ launchctl bootstrap failed:\n${r.out.trim()}`);
    console.error(`  Plist written to ${plistPath} — load it manually or re-run.`);
    process.exit(1);
  }
  console.log(`✓ installed LaunchAgent ${LABEL} (${execute ? "EXECUTE" : "dry-run"})`);
  console.log(`  plist: ${plistPath}`);
  console.log(`  logs:  ${path.join(dataDir, "dispatcher.{out,err}.log")}`);
  console.log(`  keep a board running (npm run agents) for it to have work to claim.`);
}

if (process.platform !== "darwin") {
  console.error("LaunchAgents are macOS-only. Run the dispatcher directly (npm run dispatcher) elsewhere.");
  process.exit(1);
}

if (has("--uninstall")) uninstall();
else install();
