// Pure lesson-ranking logic, extracted out of server.js. readMemory() (which
// touches disk) stays in server.js; rankLessons takes the memory array as an
// argument so it is testable in isolation.

// Words too generic to help match a lesson to a task — drop them so ranking
// keys off content words ("edgar", "wacc", "beta") to keep an unrelated
// task's prompt clean.
export const KEYWORD_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'into',
  'your', 'you', 'if', 'not', 'no', 'was', 'were', 'will', 'must', 'should',
]);

export function extractKeywords(text, max = 12) {
  const words = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !KEYWORD_STOPWORDS.has(w));
  return [...new Set(words)].slice(0, max);
}

// A stable identity for "what this lesson is about", used to supersede a
// stale/contradicting entry rather than let both sit in the list forever —
// ranking alone doesn't fix two lessons that flatly disagree. Prefers the
// files touched (strongest signal), then the lesson's own top keywords, and
// only falls back to the originating task id (so re-failing the exact same
// task at least supersedes its own prior entry).
export function lessonTopicKey(entry) {
  if (Array.isArray(entry.files) && entry.files.length) return entry.files.slice().sort().join('|');
  if (Array.isArray(entry.keywords) && entry.keywords.length >= 2) return entry.keywords.slice(0, 2).sort().join('|');
  return entry.taskId || entry.id;
}

export function lessonRelevance(lesson, keywords, files) {
  let score = 0;
  const lessonFiles = Array.isArray(lesson.files) ? lesson.files : [];
  const lessonKeywords = Array.isArray(lesson.keywords) ? lesson.keywords : [];
  for (const f of files) if (lessonFiles.includes(f)) score += 5; // an exact file match is a strong signal
  for (const k of keywords) if (lessonKeywords.includes(k)) score += 1;
  return score;
}

// Step 7: entries written before keyword/file tagging existed all score 0 in
// lessonRelevance and get filtered out forever — this makes ranking work
// retroactively instead of reintroducing recency-based selection. A pure
// function so it's easy to prove a legacy entry now scores > 0.
export function backfillLesson(entry) {
  if (Array.isArray(entry.keywords) && entry.keywords.length) return entry;
  const text = [entry.error_summary, entry.root_cause, entry.lesson].filter(Boolean).join(' ');
  return { ...entry, keywords: extractKeywords(text), files: Array.isArray(entry.files) ? entry.files : [] };
}

// Step 12: collapses entries sharing a lessonTopicKey — the same "supersede"
// rule recordLesson already applies going forward (see server.js), run once
// retroactively over the whole backlog. Newest (last in array order, which
// is append order) wins; everything else comes back as `removed` so the
// caller can archive it rather than silently drop it.
export function dedupeLessons(memory) {
  const list = Array.isArray(memory) ? memory : [];
  const lastIndexByKey = new Map();
  list.forEach((entry, i) => lastIndexByKey.set(lessonTopicKey(entry), i));
  const kept = [];
  const removed = [];
  list.forEach((entry, i) => {
    if (lastIndexByKey.get(lessonTopicKey(entry)) === i) kept.push(entry);
    else removed.push(entry);
  });
  return { kept, removed };
}

// Ranks `memory` entries against `ctx` — a single task, or (for the
// splitter) an array of candidate tasks — by keyword/file overlap. Returns
// [] when nothing overlaps at all.
export function rankLessons(memory, ctx, n = 3) {
  const tasksArr = Array.isArray(ctx) ? ctx : ctx ? [ctx] : [];
  const keywords = extractKeywords(tasksArr.map((t) => t.description || '').join(' '));
  const files = tasksArr.flatMap((t) => (Array.isArray(t.files) ? t.files : []));

  return (memory || [])
    .map((l) => ({ l, score: lessonRelevance(l, keywords, files) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((s) => s.l);
}
