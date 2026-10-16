const ALWAYS_THINKS = /^claude-(?:(?:opus|sonnet|haiku)-5-5|fable-.+|mythos-5-1)(?:-\d{8})?$/;
const THINKING_OFF = /^claude-(?:opus-5|opus-4-.+|sonnet-5|sonnet-4-.+|haiku-4-5.*|3-.+)$/;
const FAST = /opus-4-8|opus-5/;

// What a model offers when the Claude Code that listed it did not say: Claude Code's own rule for Fast mode, and whether
// Thinking can be turned off, which it cannot on models that always think. Unknown models offer neither.
export function modelCaps(model: string): { fast: boolean; thinkingOff?: boolean } {
  const id = model.replace(/\[1m\]$/i, "");
  return { fast: FAST.test(id), ...(ALWAYS_THINKS.test(id) ? { thinkingOff: false } : THINKING_OFF.test(id) ? { thinkingOff: true } : {}) };
}
