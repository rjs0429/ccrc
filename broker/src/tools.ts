// mcp__server__tool, where the tool name may hold "__" itself.
export function mcpName(name: string): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : undefined;
}

// A string member (name, description) of the meta literal a Workflow script starts with.
export function workflowMeta(script: string, key: string): string {
  const meta = /export\s+const\s+meta\s*=\s*\{/.exec(script);
  if (!meta) return "";
  const head = script.slice(meta.index, meta.index + 4000);
  const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(head);
  return m ? m[2].replace(/\\n/g, "\n").replace(/\\(.)/g, "$1") : "";
}
