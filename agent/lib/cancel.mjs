// Pure helpers for the Telegram `/cancel` flow: build the inline picker shown when
// several tasks are running, parse its button taps, and resolve a typed id-prefix
// to a single running task. Impure bits (fetching the board, POSTing the cancel)
// live in telegram-bot.mjs. Unit-tested in cancel.test.mjs.

import { repoFromTags } from "./routes.mjs";

/** callback_data for a "cancel this task" button (stays well under Telegram's 64B). */
export function cancelCallbackData(id) {
  return `cancel:${id}`;
}

/** Parse a cancel button's callback_data into `{ id }`, or null if it's not one. */
export function parseCancelCallback(data) {
  const m = /^cancel:(.+)$/.exec(String(data || ""));
  return m ? { id: m[1] } : null;
}

/** Short one-line label for a running task: title · repo · elapsed-minutes. */
export function runningLabel(task, now = Date.now()) {
  const repo = repoFromTags(task?.tags || []);
  const mins = task?.startedAt ? Math.max(0, Math.round((now - task.startedAt) / 60000)) : 0;
  const bits = [task?.title || "untitled"];
  if (repo) bits.push(repo);
  bits.push(`${mins}m`);
  return bits.join(" · ");
}

/** Inline keyboard with one "🛑 cancel" button per running task (newest cap applied). */
export function cancelKeyboard(tasks, now = Date.now(), cap = 8) {
  return {
    inline_keyboard: (Array.isArray(tasks) ? tasks : []).slice(0, cap).map((t) => [
      { text: `🛑 ${runningLabel(t, now)}`.slice(0, 60), callback_data: cancelCallbackData(t.id) },
    ]),
  };
}

/** The picker message body shown when more than one task is running. */
export function cancelPickerText(tasks) {
  const n = Array.isArray(tasks) ? tasks.length : 0;
  return `🛑 ${n} tasks running — tap the one to cancel:`;
}

/**
 * Resolve a typed id (prefix or full) to a single running task.
 * Returns `{ match, candidates }`: `match` is the unique task or null; `candidates`
 * lists every running task whose id starts with the query (so the caller can report
 * "ambiguous" vs "no match").
 */
export function matchRunningTask(tasks, query) {
  const q = String(query || "").trim().toLowerCase();
  const list = Array.isArray(tasks) ? tasks : [];
  if (!q) return { match: null, candidates: [] };
  const candidates = list.filter((t) => t && String(t.id).toLowerCase().startsWith(q));
  return { match: candidates.length === 1 ? candidates[0] : null, candidates };
}
