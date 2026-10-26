// Scripted-peer reply fragments only. Never used by the dispatcher or by the
// four-question refusal/canary fixtures (those must send their exact input).
const FOUR_OK = ['SCOPE', 'INTEGRITY', 'SAFETY', 'HEALTH']
  .map(tag => `${tag}: OK — scripted fixture ${tag.toLowerCase()} evidence`).join('\n') + '\n';
function fourQuestions(text) {
  if (/^(?:SCOPE|INTEGRITY|SAFETY|HEALTH):/m.test(text)) return text;
  // Match the final live verdict, not an example inside a Markdown fence.
  let fenced = false, verdict;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('```')) { fenced = !fenced; continue; }
    if (!fenced) verdict = line.trim().replace(/^(>\s*)+/, '').match(/^VERDICT:\s*(APPROVE|BOUNCE|DISCOVER)\b/)?.[1] || verdict;
  }
  if (!verdict) return text;
  return (verdict === 'BOUNCE' ? FOUR_OK.replace('INTEGRITY: OK', 'INTEGRITY: DEFECT') : FOUR_OK) + text;
}
function fourQuestionStream(stream) {
  function visit(value) {
    if (typeof value === 'string') return fourQuestions(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, visit(v)]));
    return value;
  }
  return stream.split('\n').map(line => { try { return JSON.stringify(visit(JSON.parse(line))); } catch { return line; } }).join('\n');
}
module.exports = { FOUR_OK, fourQuestions, fourQuestionStream };
