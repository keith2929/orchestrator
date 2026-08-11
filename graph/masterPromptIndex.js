// graph/masterPromptIndex.js — a deterministic index over MASTER_PROMPT.md:
// markdown headings -> line ranges -> text. Zero LLM, no vectors — the
// document is already structured as staged headings (see REDESIGN_PLAN.md
// Phase 10), so heading parsing suffices.
//
// Why this exists: text roles (planner, healer, ...) go through a one-shot
// completion with no file access — a pointer to MASTER_PROMPT.md is useless
// to them. This index is what makes inlining a relevant SLICE possible
// instead of choosing between the whole ~13KB document or nothing.

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

// Parses markdown into an ordered list of { heading, level, startLine,
// endLine, text }. A section runs from its own heading line to (but not
// including) the next heading at the SAME OR SHALLOWER level — a level-3
// subheading is absorbed into its level-2 parent's text, matching how a
// human would read "the section", not just the literal line under the
// heading.
export function buildIndex(markdown) {
  const lines = String(markdown || '').split('\n');
  const headings = [];
  lines.forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) headings.push({ level: m[1].length, heading: m[2].trim(), line: i });
  });

  return headings.map((h, i) => {
    let end = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        end = headings[j].line;
        break;
      }
    }
    return {
      heading: h.heading,
      level: h.level,
      startLine: h.line,
      endLine: end,
      text: lines.slice(h.line, end).join('\n').trim(),
    };
  });
}

// Resolves a heading name to its section text. Tolerant of minor drift
// (case, surrounding whitespace, a trailing status emoji/marker like
// "✅ CLEAR") since a task's source_section was captured by an LLM at plan
// time and won't always be byte-identical to the heading text.
export function resolveSection(index, name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;

  const strip = (s) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const targetStripped = strip(target);

  let hit =
    index.find((s) => s.heading.toLowerCase() === target) ||
    index.find((s) => strip(s.heading) === targetStripped) ||
    index.find((s) => strip(s.heading).includes(targetStripped) || targetStripped.includes(strip(s.heading)));

  return hit ? hit.text : null;
}

// One-line-per-heading table of contents, for a loop prompt that needs to
// show "what sections exist" without inlining all of them.
export function summarizeIndex(index) {
  return index.map((s) => `${'  '.repeat(s.level - 1)}- ${s.heading}`).join('\n');
}
