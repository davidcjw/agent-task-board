<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Task Board — agent guide

A local-first kanban (Next.js 16 + React 19 + Tailwind v4) for tracking tasks delegated to AI coding agents. Four lanes: Queued → Running → Review → Done. State lives entirely in `localStorage`.

> Note: this codebase already follows Next 16's strict React Compiler lint rules — **no ref writes during render, no synchronous `setState` inside an effect body**. The board state uses `useSyncExternalStore` partly for this reason.

## Commands

```bash
npm run dev         # dev server (Turbopack) on :3000 (serves UI + /api routes)
npm run build       # production build (must pass before shipping)
npm run lint        # ESLint — strict; must be clean
npm run typecheck   # tsc --noEmit — must be clean
npm run test        # Vitest unit suite — must be green
npm run dispatcher  # agent dispatcher (dry-run unless --execute)
npm run watcher     # merge-watcher: Review → Done when a card's PR is merged (polls gh)
npm run telegram    # inbound Telegram bot (needs TELEGRAM_BOT_TOKEN)
npm run mcp         # MCP stdio server exposing board tools
npm run agents      # control plane: board (api mode) + dispatcher + merge-watcher; one Ctrl-C stops all
npm run agents:install / agents:uninstall   # macOS LaunchAgent: run the dispatcher persistently
```

Always run `lint`, `typecheck`, `test`, and `build` before considering a change done.

## Architecture

- **Pure logic lives in `lib/`** and is framework-free and unit-tested. `board.ts` is the reducer (`addTask`, `updateTask`, `deleteTask`, `moveTask`, `commitDrag`, `claimNext`, `setResult`, `reconcile`); ids and timestamps are injectable so functions are deterministic. Add tests alongside any logic change (`lib/*.test.ts`).
- **Two engines, one contract** (`lib/boardEngine.ts`): `localEngine` (localStorage) and `apiEngine` (server-backed, polls `/api/board`). `lib/useBoard.ts` picks one by `NEXT_PUBLIC_BOARD_MODE` (`local` default | `api`) and exposes it via `useSyncExternalStore`. The `EMPTY` sentinel is both the SSR snapshot and the "not hydrated" marker. **Both engines drive the same `board.ts` reducer**, so local and live behave identically — keep it that way.
- **`BoardState`** = a flat `tasks` map + ordered id-lists per column (`columns: Record<Status, string[]>`). Reorders/moves are array splices; drag uses dnd-kit `arrayMove`.
- **Server** is in `lib/server/` (server-only — never import from client components): `store.ts` is a JSON-file board with an in-process async **mutex** so claims are atomic (one task → one agent). Route Handlers in `app/api/` (board, tasks, claim, result) wrap it.
- **Agent layer** in `agent/` (plain Node ESM, run via npm scripts): `dispatcher.mjs` (claim → route by `agent` label via `routes.json` → run → report to board + Telegram), `mcp-server.mjs` (board tools over stdio), `telegram-bot.mjs` (messages → tasks), `lib/api.mjs` + `lib/telegram.mjs`. **The dispatcher is dry-run by default**; `--execute` / `AGENT_EXECUTE=1` actually runs runner commands. Results always go to **Review** (human gate), never straight to Done.
  - `launch.mjs` (`npm run agents`) is the **process manager** that ties the layer together: it spawns the board in `api` mode, polls `/api/board` until ready, then starts the dispatcher (and the inbound bot only if `--telegram` is passed), prefixing each child's output and tearing them all down on Ctrl-C or if any one exits. The built-in bot is **off by default** — the assumed inbound front door is an external bot (e.g. hans) that enqueues via the board MCP, while the dispatcher still posts results over `TELEGRAM_BOT_TOKEN` (sending doesn't collide with an external poller; two `getUpdates` pollers on one token do → `409 Conflict`). Flags: `--execute`, `--telegram`, `--prod`, `--no-board`.
  - `launchd/install.mjs` (`npm run agents:install`) writes + loads a macOS LaunchAgent (`KeepAlive`/`RunAtLoad`) that runs only the dispatcher persistently; it widens `PATH` so the runner can find `claude`. Needs a board reachable at `BOARD_URL`.
  - `merge-watcher.mjs` (`npm run watcher`, started by `npm run agents` unless `--no-watcher`) closes the loop: each sweep it scans **Review** cards, extracts a `github.com/.../pull/N` url from `task.result` (pure helper in `lib/prs.mjs`, unit-tested in `lib/prs.test.mjs`), asks `gh` if that PR is merged, and if so moves the card to **Done** + notifies Telegram. It only shells out to `gh` when a Review card actually carries a PR url, so it's silent until there's something to watch. Interval: `WATCHER_INTERVAL` ms (default 30000) or `--interval`. The bundled `commit-push` route (in `routes.example.json`) is what produces those PRs — it wraps the prompt with a branch + `gh pr create --fill` + `BOARD_PR:` instruction. Note: `agent/**/*.test.mjs` is now in the vitest `include`.
- **UI** is in `components/`. Orchestrator `BoardApp.tsx`; drag-and-drop in `Board.tsx`; prompt-first card `TaskCard.tsx` (also renders the agent result block).

## Design system

The visual language is **vendored** from `~/code/design-systems/dragonfly-ds` into `components/ds/` (primitives `Panel`, `Text`, `Button`, `Rule` + `dragonfly.css` tokens). Do not hand-edit `components/ds/dragonfly.css` — re-vendor from source if the DS changes. Fonts (Fraunces / Inter / JetBrains Mono) are self-hosted via `next/font` and mapped onto the `--df-font-*` tokens in `app/globals.css`. Stay faithful to the dark editorial look: black canvas, hairline grid, single orange accent (`#fa4c14`), monospace labels. The four lane status colours live in `app/globals.css` (`@theme`) and `components/status.ts`.

## Conventions

- No emoji as icons — use the inline SVGs in `components/icons.tsx`.
- Tailwind class names must be literal (not interpolated) so JIT picks them up; per-status class maps live in `components/status.ts`.
- Keep it local-first: nothing should make a network request. No analytics, no backend.
