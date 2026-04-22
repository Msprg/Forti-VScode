import * as vscode from 'vscode';
import { ConfigBlock, ConfigEntry, Document, findBlock, pathKey } from '../parser';

export type StagedTarget =
  | { kind: 'block'; path: string[] }
  | { kind: 'entry'; path: string[]; name: string };

export interface StagedBlockOverride {
  kind: 'block';
  path: string[];
  /** The replacement block parsed from the saved buffer. Empty block means "all cleared". */
  block: ConfigBlock;
}

export interface StagedEntryOverride {
  kind: 'entry';
  path: string[];
  name: string;
  /** The replacement entry parsed from the saved buffer. */
  entry: ConfigEntry;
}

export type StagedOverride = StagedBlockOverride | StagedEntryOverride;

export function targetKey(target: StagedTarget): string {
  if (target.kind === 'block') return `B|${pathKey(target.path)}`;
  return `E|${pathKey(target.path)}|${target.name}`;
}

/**
 * In-memory map of staged overrides keyed by their target. Writes fire `onDidChange`
 * so the tree, status bar, and decorations can react synchronously.
 */
export class StagedChanges implements vscode.Disposable {
  private readonly map = new Map<string, StagedOverride>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  dispose(): void {
    this.emitter.dispose();
    this.map.clear();
  }

  count(): number {
    return this.map.size;
  }

  list(): StagedOverride[] {
    return Array.from(this.map.values());
  }

  get(target: StagedTarget): StagedOverride | undefined {
    return this.map.get(targetKey(target));
  }

  set(override: StagedOverride): void {
    this.map.set(targetKey(override), override);
    this.emitter.fire();
  }

  delete(target: StagedTarget): void {
    if (this.map.delete(targetKey(target))) this.emitter.fire();
  }

  clear(): void {
    if (this.map.size === 0) return;
    this.map.clear();
    this.emitter.fire();
  }

  /** Paths (as `a b c` joined strings) that have either block-level or any entry-level override. */
  touchedPaths(): string[] {
    const s = new Set<string>();
    for (const v of this.map.values()) s.add(pathKey(v.path));
    return Array.from(s);
  }

  /**
   * Returns true if the given top-level path (or any entry beneath it) has staged changes.
   */
  isPathModified(path: string[]): boolean {
    const k = pathKey(path);
    for (const v of this.map.values()) if (pathKey(v.path) === k) return true;
    return false;
  }

  isEntryModified(path: string[], name: string): boolean {
    return this.map.has(targetKey({ kind: 'entry', path, name }));
  }

  /**
   * Produce a new `Document` by applying every staged override onto the given pristine doc.
   * Block-level overrides replace the entire matching block. Entry-level overrides replace
   * a single entry inside the matching block, or insert it if absent.
   *
   * The returned Document is a shallow clone with modified blocks replaced wholesale.
   */
  compose(pristine: Document): Document {
    const blocks = pristine.blocks.map((b) => cloneBlock(b));
    const doc: Document = { blocks };

    // Block-level overrides first.
    for (const v of this.map.values()) {
      if (v.kind !== 'block') continue;
      const idx = doc.blocks.findIndex((b) => pathKey(b.path) === pathKey(v.path));
      if (idx >= 0) doc.blocks[idx] = cloneBlock(v.block);
      else doc.blocks.push(cloneBlock(v.block));
    }

    // Then entry-level overrides, which refine whichever block is now current.
    for (const v of this.map.values()) {
      if (v.kind !== 'entry') continue;
      let block = findBlock(doc, v.path);
      if (!block) {
        block = { path: v.path.slice(), entries: new Map(), settings: new Map(), children: [] };
        doc.blocks.push(block);
      }
      block.entries.set(v.name, cloneEntry(v.entry));
    }

    return doc;
  }
}

export function cloneBlock(block: ConfigBlock): ConfigBlock {
  return {
    path: block.path.slice(),
    entries: new Map(Array.from(block.entries, ([k, e]) => [k, cloneEntry(e)])),
    settings: new Map(Array.from(block.settings, ([k, s]) => [k, { ...s, values: s.values.slice() }])),
    children: block.children.map(cloneBlock),
  };
}

export function cloneEntry(entry: ConfigEntry): ConfigEntry {
  return {
    name: entry.name,
    settings: new Map(Array.from(entry.settings, ([k, s]) => [k, { ...s, values: s.values.slice() }])),
    children: entry.children.map(cloneBlock),
  };
}
