// Choices the agent puts to the user, drawn as cards (as Claude desktop's
// question cards). The agent ends a turn with ONE fenced block:
//
//   ```choices
//   Which workflow should I use?
//   1. Local - LTX 2.5 | runs on this GPU, needs 25 GB of models
//   2. API - Kling 3 | partner nodes, costs credits
//   ```
//
// The lines before the first option are the question, every "<n>. <label>"
// line an option, the text after "|" its detail. A click on a card sends that
// option as the user's message (answerFor - the same words agentY's
// src/utils/choices.py spells a bare number out to, so typing "2" or clicking
// the second card reach the agent alike). Slack gets a numbered list instead
// (agentY's slack_render). Pure: no DOM, no ComfyUI.

export const MAX_OPTIONS = 6;
const BLOCK_RE = /```[ \t]*choices[ \t]*\r?\n([\s\S]*?)```/gi;
const OPTION_RE = /^\s*(\d{1,2})[.)]\s+(\S.*?)\s*$/;

export function parseBlock(body) {
  const question = [];
  let options = [];
  for (const line of String(body || "").split(/\r?\n/)) {
    const m = OPTION_RE.exec(line);
    if (m) {
      const text = m[2];
      const bar = text.indexOf("|");
      const label = (bar < 0 ? text : text.slice(0, bar)).trim();
      const detail = bar < 0 ? "" : text.slice(bar + 1).trim();
      options.push({ n: options.length + 1, label, detail });
      continue;
    }
    if (line.trim() && !options.length) question.push(line.trim());
  }
  options = options.filter((o) => o.label).slice(0, MAX_OPTIONS);
  if (options.length < 2) return null;
  return { question: question.join(" "), options };
}

// The text cut into pieces: {text} for plain markdown, {choice} for a block.
// An unclosed block (still streaming) stays text.
export function splitChoices(text) {
  const s = String(text || "");
  const out = [];
  let last = 0;
  BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_RE.exec(s))) {
    const choice = parseBlock(m[1]);
    if (!choice) continue;
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ choice });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

export function findChoices(text) {
  const c = splitChoices(text).filter((p) => p.choice);
  return c.length ? c[c.length - 1].choice : null;
}

export function answerFor(opt) {
  return `${opt.n}. ${opt.label}${opt.detail ? ` (${opt.detail})` : ""}`;
}

// The cards as HTML (so they survive the panel being saved as HTML and
// rendered again); clicks are taken by one listener on the log (data-answer).
export function choicesHtml(choice, escapeHtml) {
  const q = choice.question ? `<div class="ay-choices-q">${escapeHtml(choice.question)}</div>` : "";
  const cards = choice.options.map((o) =>
    `<button type="button" class="ay-choice" data-answer="${escapeHtml(answerFor(o))}">` +
    `<span class="ay-choice-n">${o.n}</span><span class="ay-choice-body">` +
    `<span class="ay-choice-label">${escapeHtml(o.label)}</span>` +
    (o.detail ? `<span class="ay-choice-detail">${escapeHtml(o.detail)}</span>` : "") +
    `</span></button>`).join("");
  return `<div class="ay-choices" role="group">${q}<div class="ay-choices-list">${cards}</div>` +
    `<div class="ay-choices-hint">Click one, or type your own answer.</div></div>`;
}

export const CHOICES_CSS = `
.ay-choices { margin: 8px 0 2px; display: flex; flex-direction: column; gap: 6px; }
.ay-choices-q { font-weight: 600; }
.ay-choices-list { display: flex; flex-direction: column; gap: 6px; }
.ay-choice { display: flex; align-items: flex-start; gap: 10px; text-align: left; width: 100%;
  padding: 8px 10px; border-radius: 8px; cursor: pointer; font: inherit; color: inherit;
  background: var(--ay-surface);
  border: 1px solid var(--ay-border); }
.ay-choice:hover:not(:disabled) { border-color: var(--ay-accent);
  background: var(--ay-accent-soft); }
.ay-choice:disabled { cursor: default; opacity: 0.5; }
.ay-choice.picked { opacity: 1; border-color: var(--ay-accent); }
.ay-choice-n { flex: 0 0 auto; min-width: 20px; height: 20px; border-radius: 5px; display: inline-flex;
  align-items: center; justify-content: center; font-size: 11px;
  border: 1px solid var(--ay-border); }
.ay-choice-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ay-choice-label { font-weight: 600; overflow-wrap: anywhere; }
.ay-choice-detail { opacity: 0.7; font-size: 0.92em; overflow-wrap: anywhere; }
.ay-choices-hint { opacity: 0.55; font-size: 0.85em; }
.ay-choices.answered .ay-choices-hint { display: none; }
`;
