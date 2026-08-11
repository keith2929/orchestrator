// core/sessionContext.js — pure formatting/bounding logic for two unbounded-
// growth spots (see HARDENING_PLAN.md step 9): session_context.md appending
// the WHOLE dirty tree per task instead of just that task's own changes, and
// planner_chat.json replaying its entire transcript to the model every turn.

// Formats the "task completed" block appended to session_context.md, listing
// only the files that changed BETWEEN two `git status --porcelain` snapshots
// (before this task started, after it finished) — not every file dirty in
// the tree, which includes every earlier task's leftovers too. Capped so one
// chatty task can't dump hundreds of paths into every later task's prompt.
export function formatSessionContextBlock(taskId, beforeFiles, afterFiles, cap = 25) {
  const before = new Set(beforeFiles || []);
  const ownFiles = (afterFiles || []).filter((f) => !before.has(f));
  const shown = ownFiles.slice(0, cap);
  const extra = ownFiles.length - shown.length;
  const list = shown.length ? shown.join(', ') : '(none detected)';
  const suffix = extra > 0 ? `, … and ${extra} more` : '';
  return `\n---\nTask ${taskId} completed. Changed files: ${list}${suffix}\n`;
}

// Returns null when `content` is within `capBytes`. Otherwise splits it in
// half (by character, matching the newline-delimited block format) and
// returns { archived, kept } — the caller writes `archived` to a dated
// history file and keeps `kept` as the live session_context.md.
export function rolloverContent(content, capBytes) {
  if (Buffer.byteLength(content, 'utf8') <= capBytes) return null;
  const mid = Math.floor(content.length / 2);
  return { archived: content.slice(0, mid), kept: content.slice(mid) };
}

// Bounds what gets REPLAYED to the model each turn — the first message (sets
// up context) plus the most recent `recentN`. The full transcript is still
// persisted by the caller; only this windowed view is sent.
export function windowPlannerChat(messages, recentN = 20) {
  const arr = Array.isArray(messages) ? messages : [];
  if (arr.length <= recentN + 1) return arr;
  return [arr[0], ...arr.slice(-recentN)];
}
