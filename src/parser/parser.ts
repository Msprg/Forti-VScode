import {
  ConfigBlock,
  ConfigEntry,
  Document,
  Setting,
  newBlock,
  newEntry,
} from './ast';
import { tokenizeValues } from './lexer';

export class ParseError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

/**
 * Parse FortiGate CLI text (typically the output of `show`) into a Document AST.
 *
 * Recognised commands:
 *   - `config <path tokens...>`
 *   - `edit <name>`
 *   - `next`
 *   - `end`
 *   - `set <key> <value tokens...>`
 *   - `unset <key>`
 * Blank lines and `#`-prefixed comment/header lines are ignored.
 */
export function parse(text: string): Document {
  const lines = text.split(/\r\n|\n|\r/);
  const doc: Document = { blocks: [] };

  // Stack of scopes. Each scope is either a ConfigBlock or a ConfigEntry.
  type Scope =
    | { kind: 'block'; node: ConfigBlock }
    | { kind: 'entry'; node: ConfigEntry; parentBlock: ConfigBlock };
  const stack: Scope[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) continue;

    // First token determines command.
    const first = readFirstToken(trimmed);
    const rest = trimmed.slice(first.length).replace(/^\s+/, '');

    if (first === 'config') {
      const pathTokens = tokenizeValues(rest);
      if (pathTokens.length === 0) {
        throw new ParseError('`config` requires a path', lineNo);
      }
      const block = newBlock(pathTokens);
      const top = stack[stack.length - 1];
      if (!top) {
        doc.blocks.push(block);
      } else if (top.kind === 'entry') {
        top.node.children.push(block);
      } else {
        top.node.children.push(block);
      }
      stack.push({ kind: 'block', node: block });
      continue;
    }

    if (first === 'end') {
      const top = stack.pop();
      if (!top || top.kind !== 'block') {
        throw new ParseError('`end` with no matching `config`', lineNo);
      }
      continue;
    }

    if (first === 'edit') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'block') {
        throw new ParseError('`edit` outside of a `config` block', lineNo);
      }
      const nameTokens = tokenizeValues(rest);
      if (nameTokens.length === 0) {
        throw new ParseError('`edit` requires a name', lineNo);
      }
      // FortiGate edit names are a single token (quoted or unquoted).
      const name = nameTokens.join(' ');
      const entry = newEntry(name);
      top.node.entries.set(name, entry);
      stack.push({ kind: 'entry', node: entry, parentBlock: top.node });
      continue;
    }

    if (first === 'next') {
      const top = stack.pop();
      if (!top || top.kind !== 'entry') {
        throw new ParseError('`next` with no matching `edit`', lineNo);
      }
      continue;
    }

    if (first === 'set' || first === 'unset') {
      const tokens = tokenizeValues(rest);
      if (tokens.length === 0) {
        throw new ParseError(`\`${first}\` requires a key`, lineNo);
      }
      const [key, ...values] = tokens;
      const setting: Setting = { key, values, unset: first === 'unset' };
      const top = stack[stack.length - 1];
      if (!top) {
        throw new ParseError(`\`${first}\` at top level`, lineNo);
      }
      if (top.kind === 'entry') {
        top.node.settings.set(key, setting);
      } else {
        top.node.settings.set(key, setting);
      }
      continue;
    }

    // Quietly ignore other interactive-only commands (get, show, purge, etc).
    // They should not appear in a pristine `show` dump but may show up when users
    // paste snippets.
  }

  return doc;
}

function readFirstToken(line: string): string {
  const m = /^\S+/.exec(line);
  return m ? m[0] : '';
}
