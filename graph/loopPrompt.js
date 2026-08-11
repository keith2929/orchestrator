// graph/loopPrompt.js — mechanical (zero LLM) assembly of a goal-loop
// cycle's replan brief. Every value here comes from code, not a model: this
// cycle's high-severity audit issues (with the healer's own diagnosis/
// fix_summary where available), an inventory of every existing task id with
// a one-line status, and the MASTER_PROMPT.md sections the affected tasks
// were derived from (via source_section + masterPromptIndex.js). The
// planner then replans additively against just this brief instead of the
// whole master prompt — see REDESIGN_PLAN.md Phase 10.
export function assembleLoopPrompt({ cycle, issues, taskInventory, sections }) {
  const lines = [`# Replan brief — cycle ${cycle}`, ''];

  lines.push("## Issues from this cycle's audit", '');
  if (!issues || !issues.length) {
    lines.push('(none)');
  } else {
    issues.forEach((iss, i) => {
      lines.push(`${i + 1}. [${iss.severity}] ${iss.task || 'general'}: ${iss.description}`);
      if (iss.diagnosis) lines.push(`   Diagnosis: ${iss.diagnosis}`);
      if (iss.fix_summary) lines.push(`   Suggested fix: ${iss.fix_summary}`);
      lines.push('');
    });
  }

  lines.push('## Existing tasks — DO NOT repeat, redefine, or re-run any of these', '');
  if (!taskInventory || !taskInventory.length) {
    lines.push('(none)');
  } else {
    taskInventory.forEach((t) => lines.push(`- ${t.id} [${t.status}]: ${t.description}`));
  }
  lines.push('');

  if (sections && sections.length) {
    lines.push('## Relevant MASTER PROMPT sections (context for WHY these issues matter)', '');
    for (const s of sections) {
      lines.push(`### ${s.heading}`, '', s.text, '');
    }
  }

  return lines.join('\n');
}
