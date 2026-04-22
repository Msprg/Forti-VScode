import { ConfigBlock, ConfigEntry, Document, Setting } from './ast';
import { quoteIfNeeded } from './lexer';

const INDENT = '    ';

export interface SerializeOptions {
  /** Starting indent level. Defaults to 0. */
  indent?: number;
}

export function serialize(doc: Document, opts: SerializeOptions = {}): string {
  const lines: string[] = [];
  for (const block of doc.blocks) {
    serializeBlock(block, opts.indent ?? 0, lines);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

export function serializeBlock(block: ConfigBlock, depth: number, out: string[]): void {
  const pad = INDENT.repeat(depth);
  const pathText = block.path.map((p) => quoteIfNeeded(p)).join(' ');
  out.push(`${pad}config ${pathText}`);
  for (const setting of block.settings.values()) {
    out.push(serializeSetting(setting, depth + 1));
  }
  for (const child of block.children) {
    serializeBlock(child, depth + 1, out);
  }
  for (const entry of block.entries.values()) {
    serializeEntry(entry, depth + 1, out);
  }
  out.push(`${pad}end`);
}

export function serializeEntry(entry: ConfigEntry, depth: number, out: string[]): void {
  const pad = INDENT.repeat(depth);
  out.push(`${pad}edit ${quoteEditName(entry.name)}`);
  for (const setting of entry.settings.values()) {
    out.push(serializeSetting(setting, depth + 1));
  }
  for (const child of entry.children) {
    serializeBlock(child, depth + 1, out);
  }
  out.push(`${pad}next`);
}

export function serializeSetting(setting: Setting, depth: number): string {
  const pad = INDENT.repeat(depth);
  if (setting.unset) {
    return `${pad}unset ${setting.key}`;
  }
  const values = setting.values.map((v) => quoteIfNeeded(v)).join(' ');
  return values.length > 0 ? `${pad}set ${setting.key} ${values}` : `${pad}set ${setting.key}`;
}

/**
 * `edit` names are almost always quoted unless they are purely numeric.
 * This matches FortiGate `show` output closely, minimising spurious diffs.
 */
export function quoteEditName(name: string): string {
  if (/^[0-9]+$/.test(name)) return name;
  return quoteIfNeeded(name) === name ? `"${name}"` : quoteIfNeeded(name);
}
