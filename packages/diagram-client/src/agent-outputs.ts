/**
 * An agent's answer, formatted for reading.
 *
 * A wfpy agent finishes a turn by writing its ports, and the runtime reports
 * that as one JSON object, `{"outputs": {"<port>": "<value>"}}`. A port's
 * value is itself usually JSON, so the text that reaches the chat is escaped
 * twice: a unified diff arrives as one line of `\n` and `\"` and renders as a
 * single unreadable paragraph.
 *
 * `formatAgentOutputs` turns that into Markdown, which the panel already knows
 * how to render and sanitize: a heading per port, one line per scalar field,
 * and a fenced block for anything long, tagged `diff` when it is one. It
 * returns null for anything that is not an outputs object, so ordinary replies
 * go through untouched.
 */

/** A value that reads better as a block than as a line. */
function isBlock(value: string): boolean {
  return value.includes('\n') || value.length > 160;
}

/** Whether a string is a unified diff, i.e. worth syntax colouring as one. */
function isDiff(value: string): boolean {
  return /^---\s+\S/m.test(value) && /^\+\+\+\s+\S/m.test(value) || /^@@ -\d/m.test(value);
}

/** A fence long enough to hold a value that itself contains backticks. */
function fence(value: string): string {
  let ticks = 3;
  for (const run of value.match(/`+/g) ?? []) ticks = Math.max(ticks, run.length + 1);
  return '`'.repeat(ticks);
}

function block(value: string, lang: string): string {
  const f = fence(value);
  return `${f}${lang}\n${value.replace(/\s+$/, '')}\n${f}`;
}

/** One field of a port's value. */
function field(key: string, value: unknown): string {
  if (value === null || value === undefined) return `- **${key}** \`null\``;
  if (typeof value === 'boolean' || typeof value === 'number') return `- **${key}** \`${value}\``;
  if (typeof value === 'string') {
    if (!value) return `- **${key}** \`""\``;
    if (isBlock(value)) return `**${key}**\n\n${block(value, isDiff(value) ? 'diff' : '')}`;
    // Prose keeps its punctuation; anything else reads as a value.
    const prose = /\s/.test(value) && /[.,;]/.test(value);
    return prose ? `- **${key}** ${value}` : `- **${key}** \`${value}\``;
  }
  return `**${key}**\n\n${block(JSON.stringify(value, null, 2), 'json')}`;
}

/** One port: its name, then its fields, scalars before blocks. */
function port(name: string, value: unknown): string {
  let inner: unknown = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        inner = JSON.parse(text);
      } catch {
        inner = value;
      }
    }
  }
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
    return `### ${name}\n\n${field('value', inner).replace(/^- \*\*value\*\* /, '')}`;
  }
  const entries = Object.entries(inner as Record<string, unknown>);
  const lines = entries.filter(([, v]) => !(typeof v === 'string' && isBlock(v)) && typeof v !== 'object');
  const blocks = entries.filter(([, v]) => (typeof v === 'string' && isBlock(v)) || (v !== null && typeof v === 'object'));
  const parts: string[] = [`### ${name}`];
  if (lines.length) parts.push(lines.map(([k, v]) => field(k, v)).join('\n'));
  for (const [k, v] of blocks) parts.push(field(k, v));
  return parts.join('\n\n');
}

/**
 * Markdown for an agent's outputs object, or null when `text` is not one.
 */
export function formatAgentOutputs(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"outputs"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const outputs = (parsed as Record<string, unknown>)['outputs'];
  if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) return null;
  const entries = Object.entries(outputs as Record<string, unknown>);
  if (!entries.length) return null;
  return entries.map(([name, value]) => port(name, value)).join('\n\n');
}
