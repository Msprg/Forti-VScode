/**
 * Lexer for FortiGate CLI value tokens.
 *
 * FortiGate tokenization rules we support:
 *   - Whitespace separates tokens.
 *   - Double-quoted strings "..." are a single token. Inside, `\"` and `\\` are escapes.
 *   - Any other run of non-whitespace characters is an identifier/numeric token.
 *
 * This is intentionally forgiving: unknown escapes inside a quoted string are kept verbatim
 * (minus the leading backslash), which matches observed FortiGate behavior.
 */
export function tokenizeValues(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input.charCodeAt(i);
    if (ch === 0x20 /* space */ || ch === 0x09 /* tab */) {
      i++;
      continue;
    }
    if (input[i] === '"') {
      const { value, end } = readQuoted(input, i);
      tokens.push(value);
      i = end;
      continue;
    }
    const start = i;
    while (i < n) {
      const c = input[i];
      if (c === ' ' || c === '\t') break;
      i++;
    }
    tokens.push(input.slice(start, i));
  }
  return tokens;
}

function readQuoted(input: string, start: number): { value: string; end: number } {
  let i = start + 1;
  const n = input.length;
  let out = '';
  while (i < n) {
    const c = input[i];
    if (c === '\\' && i + 1 < n) {
      const next = input[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i += 2;
        continue;
      }
      // Preserve any other escape as the literal following char.
      out += next;
      i += 2;
      continue;
    }
    if (c === '"') {
      return { value: out, end: i + 1 };
    }
    out += c;
    i++;
  }
  // Unterminated quoted string: accept whatever we collected.
  return { value: out, end: i };
}

/**
 * Quote a value if it contains any character that would break unambiguous parsing.
 * Pure alphanumeric + `._-:/` identifiers are left bare, matching common `show` output.
 * Empty strings are always quoted.
 */
export function quoteIfNeeded(value: string): string {
  if (value === '') return '""';
  if (/^[A-Za-z0-9_.:/\-]+$/.test(value)) return value;
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
