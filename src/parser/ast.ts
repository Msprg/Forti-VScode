/**
 * AST for the subset of FortiGate CLI that `show` output uses.
 *
 * A `config <path...>` block can contain either:
 *   - direct settings (for singleton blocks like `config system global`), or
 *   - table entries via `edit <name>` / `next` (for tables like `config firewall policy`).
 *
 * Entries themselves can contain settings and nested config blocks.
 *
 * We preserve the insertion order of entries, settings, and children to keep
 * serialized output stable and diffs readable.
 */

export interface Setting {
  /** Setting key, e.g. "member", "allowaccess". */
  key: string;
  /** Ordered list of parsed (unquoted) value tokens. May be empty for `unset`. */
  values: string[];
  /** True if the source used `unset` instead of `set`. */
  unset?: boolean;
}

export interface ConfigEntry {
  /** The `edit <name>` identifier, stored unquoted. */
  name: string;
  settings: Map<string, Setting>;
  children: ConfigBlock[];
}

export interface ConfigBlock {
  /** The path tokens after `config`, e.g. ["firewall", "policy"]. */
  path: string[];
  /**
   * Table entries keyed by `edit` name in source order. Empty for singleton blocks.
   * Map preserves insertion order.
   */
  entries: Map<string, ConfigEntry>;
  /** Direct settings on the block itself (for singleton blocks). */
  settings: Map<string, Setting>;
  /** Nested config blocks (rare at block-level; more often inside entries). */
  children: ConfigBlock[];
}

export interface Document {
  /** Top-level `config <path> ... end` blocks in source order. */
  blocks: ConfigBlock[];
}

export function newBlock(path: string[]): ConfigBlock {
  return { path, entries: new Map(), settings: new Map(), children: [] };
}

export function newEntry(name: string): ConfigEntry {
  return { name, settings: new Map(), children: [] };
}

/** Join a config path with single spaces, e.g. ["firewall","policy"] -> "firewall policy". */
export function pathKey(path: string[]): string {
  return path.join(' ');
}

/** Look up a top-level block by path. */
export function findBlock(doc: Document, path: string[]): ConfigBlock | undefined {
  const key = pathKey(path);
  return doc.blocks.find((b) => pathKey(b.path) === key);
}
