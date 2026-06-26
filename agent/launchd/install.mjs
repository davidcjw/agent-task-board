#!/usr/bin/env node
// install.mjs — install/uninstall a macOS LaunchAgent that keeps the WHOLE agent
// control plane running in the background (board + dispatcher + merge-watcher +
// inbound bot, via launch.mjs). It starts at login and restarts if it crashes.
//
// Unlike a bare dispatcher this provides its own board, so nothing else needs to
// be running. Don't also run `npm run agents` by hand while it's loaded — two
// boards would clash on port 3000. Logs: .data/controlplane.{out,err}.log.
//
//   node agent/launchd/install.mjs               # install + load (dry-run dispatcher)
//   node agent/launchd/install.mjs --execute     # actually run runners + open PRs
//   node agent/launchd/install.mjs --prod        # serve a production build (builds first)
//   node agent/launchd/install.mjs --no-telegram # don't run the inbound bot
//   node agent/launchd/install.mjs --no-watcher  # don't run the merge-watcher
//   node agent/launchd/install.mjs --print       # print the plist and exit (no changes)
//   node agent/launchd/install.mjs --uninstall   # unload + remove
//
// Or via npm: `npm run agents:install [-- --execute --prod ...]` / `npm run agents:uninstall`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LABEL = "com.davidcjw.agent-task-board.controlplane";
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

function buildPlist({ program, dataDir, pathEnv }) {
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
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(path.join(dataDir, "controlplane.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(dataDir, "controlplane.err.log"))}</string>
</dict>
</plist>
`;
}

function install() {
  const execute = has("--execute");
  const prod = has("--prod");
  // Flags forwarded verbatim to launch.mjs (the same plane `npm run agents` runs).
  const passthrough = ["--execute", "--prod", "--no-telegram", "--no-watcher"].filter(has);
  const dataDir = path.join(repoRoot, ".data");

  const program = [
    process.execPath, // absolute node path (handles nvm)
    "--env-file-if-exists=.env",
    "agent/launch.mjs",
    ...passthrough,
  ];
  // launchd gives a minimal PATH; widen it so runners can find `claude`, `gh`, etc.
  const pathEnv = [
    path.dirname(process.execPath),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");

  const plist = buildPlist({ program, dataDir, pathEnv });

  if (has("--print")) {
    console.log(plist);
    return;
  }

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.dirname(plistPath), { recursive: true });

  // --prod serves a production build, which must exist first.
  if (prod) {
    console.log("building (npm run build) for --prod…");
    const b = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    if (b.status !== 0) {
      console.error("✗ build failed — fix it, then re-run.");
      process.exit(1);
    }
  }

  writeFileSync(plistPath, plist);
  // Reload cleanly: boot out an old copy first (ignore failure), then bootstrap.
  launchctl("bootout", `${domain}/${LABEL}`);
  const r = launchctl("bootstrap", domain, plistPath);
  if (r.code !== 0) {
    console.error(`✗ launchctl bootstrap failed:\n${r.out.trim()}`);
    console.error(`  Plist written to ${plistPath} — load it manually or re-run.`);
    process.exit(1);
  }
  console.log(`✓ installed control-plane LaunchAgent ${LABEL} (${execute ? "EXECUTE" : "dry-run"}${prod ? ", prod build" : ""})`);
  console.log(`  plist: ${plistPath}`);
  console.log(`  logs:  ${path.join(dataDir, "controlplane.{out,err}.log")}`);
  console.log(`  running: board + dispatcher + watcher${has("--no-telegram") ? "" : " + bot"} — starts at login, restarts on crash.`);
  console.log(`  don't also run \`npm run agents\` by hand — two boards would clash on port 3000.`);
}

if (process.platform !== "darwin") {
  console.error("LaunchAgents are macOS-only. Run the control plane directly (npm run agents) elsewhere.");
  process.exit(1);
}

if (has("--uninstall")) uninstall();
else install();
