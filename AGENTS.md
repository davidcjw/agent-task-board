<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Task Board — agent guide

A local-first kanban (Next.js 16 + React 19 + Tailwind v4) for tracking tasks delegated to AI coding agents. Four lanes: Queued → Running → Review → Done. State lives entirely in `localStorage`.

> Note: this codebase already follows Next 16's strict React Compiler lint rules — **no ref writes during render, no synchronous `setState` inside an effect body**. The board state uses `useSyncExternalStore` partly for this reason.

## Commands

```bash
npm run dev        # dev server (Turbopack) on :3000
npm run build      # production build (must pass before shipping)
npm run lint       # ESLint — strict; must be clean
npm run typecheck  # tsc --noEmit — must be clean
npm run test       # Vitest unit suite — must be green
```

Always run `lint`, `typecheck`, `test`, and `build` before considering a change done.

## Architecture

- **Pure logic lives in `lib/`** and is framework-free and unit-tested. `board.ts` is the reducer (`addTask`, `updateTask`, `deleteTask`, `moveTask`, `commitDrag`, `reconcile`); ids and timestamps are injectable so functions are deterministic. Add tests alongside any logic change (`lib/*.test.ts`).
- **State** is an external store wrapped with `useSyncExternalStore` in `lib/useBoard.ts` (SSR-safe; the `EMPTY` sentinel doubles as the server snapshot and the "not yet hydrated" marker). Mutations go through pure `board.ts` functions, then persist + emit.
- **`BoardState`** = a flat `tasks` map + ordered id-lists per column (`columns: Record<Status, string[]>`). Reorders/moves are array splices; drag uses dnd-kit `arrayMove`.
- **UI** is in `components/`. The board orchestrator is `BoardApp.tsx`. Drag-and-drop lives in `Board.tsx` (`DndContext` + `commitDrag`); the prompt-first card is `TaskCard.tsx`.

## Design system

The visual language is **vendored** from `~/code/design-systems/dragonfly-ds` into `components/ds/` (primitives `Panel`, `Text`, `Button`, `Rule` + `dragonfly.css` tokens). Do not hand-edit `components/ds/dragonfly.css` — re-vendor from source if the DS changes. Fonts (Fraunces / Inter / JetBrains Mono) are self-hosted via `next/font` and mapped onto the `--df-font-*` tokens in `app/globals.css`. Stay faithful to the dark editorial look: black canvas, hairline grid, single orange accent (`#fa4c14`), monospace labels. The four lane status colours live in `app/globals.css` (`@theme`) and `components/status.ts`.

## Conventions

- No emoji as icons — use the inline SVGs in `components/icons.tsx`.
- Tailwind class names must be literal (not interpolated) so JIT picks them up; per-status class maps live in `components/status.ts`.
- Keep it local-first: nothing should make a network request. No analytics, no backend.
