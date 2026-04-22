import {
  ConfigBlock,
  ConfigEntry,
  Document,
  Setting,
  findBlock,
  newBlock,
  newEntry,
  pathKey,
  quoteIfNeeded,
} from '../parser';
import { quoteEditName } from '../parser/serializer';

/**
 * A set of CLI commands scoped to a single top-level `config <path> ... end`
 * transaction. `commands` includes both the enclosing `config`/`end` lines and
 * the body, suitable to pass directly to `runScript`.
 */
export interface ChangeGroup {
  path: string[];
  commands: string[];
}

export interface ChangeScript {
  groups: ChangeGroup[];
  /** All top-level paths touched by this script. */
  touchedPaths(): string[][];
  /** Flat list of all commands across groups, for preview or raw apply. */
  allCommands(): string[];
  /** True if there is nothing to apply. */
  isEmpty(): boolean;
}

export function build(pristine: Document, staged: Document): ChangeScript {
  const groups: ChangeGroup[] = [];
  const touched = new Map<string, string[]>();

  // Collect all candidate top-level paths from either side.
  const paths: string[][] = [];
  for (const b of staged.blocks) paths.push(b.path);
  for (const b of pristine.blocks) {
    if (!paths.some((p) => pathKey(p) === pathKey(b.path))) paths.push(b.path);
  }

  for (const path of paths) {
    const p = findBlock(pristine, path) ?? newBlock(path);
    const s = findBlock(staged, path) ?? newBlock(path);
    const body = diffBlockBody(p, s);
    if (body.length === 0) continue;
    const commands = [`config ${serializePath(path)}`, ...body.map((l) => indent(l, 1)), 'end'];
    groups.push({ path, commands });
    touched.set(pathKey(path), path);
  }

  return {
    groups,
    touchedPaths: () => Array.from(touched.values()),
    allCommands: () => groups.flatMap((g) => g.commands),
    isEmpty: () => groups.length === 0,
  };
}

/**
 * Produce body commands (without the enclosing `config`/`end`) that transform
 * `p` into `s` for a single block.
 */
function diffBlockBody(p: ConfigBlock, s: ConfigBlock): string[] {
  const out: string[] = [];

  // Direct settings.
  out.push(...diffSettings(p.settings, s.settings));

  // Nested config children (non-entry). Matched by pathKey.
  const pChildren = new Map(p.children.map((c) => [pathKey(c.path), c]));
  const sChildren = new Map(s.children.map((c) => [pathKey(c.path), c]));
  for (const [k, sChild] of sChildren) {
    const pChild = pChildren.get(k) ?? newBlock(sChild.path);
    const body = diffBlockBody(pChild, sChild);
    if (body.length === 0) continue;
    out.push(`config ${serializePath(sChild.path)}`);
    for (const line of body) out.push(indent(line, 1));
    out.push('end');
  }
  // Children removed on staged side: we don't attempt to dismantle, FortiGate
  // rarely supports deleting nested structural configs. Skip silently.

  // Entries.
  for (const [name, sEntry] of s.entries) {
    const pEntry = p.entries.get(name);
    if (!pEntry) {
      out.push(`edit ${quoteEditName(name)}`);
      out.push(...buildEntryBody(sEntry).map((l) => indent(l, 1)));
      out.push('next');
      continue;
    }
    const entryBody = diffEntryBody(pEntry, sEntry);
    if (entryBody.length === 0) continue;
    out.push(`edit ${quoteEditName(name)}`);
    for (const line of entryBody) out.push(indent(line, 1));
    out.push('next');
  }
  // Entries removed.
  for (const name of p.entries.keys()) {
    if (!s.entries.has(name)) {
      out.push(`delete ${quoteEditName(name)}`);
    }
  }

  return out;
}

function diffEntryBody(p: ConfigEntry, s: ConfigEntry): string[] {
  const out: string[] = [];
  out.push(...diffSettings(p.settings, s.settings));
  const pChildren = new Map(p.children.map((c) => [pathKey(c.path), c]));
  const sChildren = new Map(s.children.map((c) => [pathKey(c.path), c]));
  for (const [k, sChild] of sChildren) {
    const pChild = pChildren.get(k) ?? newBlock(sChild.path);
    const body = diffBlockBody(pChild, sChild);
    if (body.length === 0) continue;
    out.push(`config ${serializePath(sChild.path)}`);
    for (const line of body) out.push(indent(line, 1));
    out.push('end');
  }
  return out;
}

function diffSettings(p: Map<string, Setting>, s: Map<string, Setting>): string[] {
  const out: string[] = [];
  for (const [k, sSetting] of s) {
    const pSetting = p.get(k);
    if (!pSetting) {
      out.push(renderSet(sSetting));
      continue;
    }
    if (!sameSetting(pSetting, sSetting)) {
      out.push(renderSet(sSetting));
    }
  }
  for (const [k] of p) {
    if (!s.has(k)) out.push(`unset ${k}`);
  }
  return out;
}

function sameSetting(a: Setting, b: Setting): boolean {
  if ((a.unset ?? false) !== (b.unset ?? false)) return false;
  if (a.values.length !== b.values.length) return false;
  for (let i = 0; i < a.values.length; i++) if (a.values[i] !== b.values[i]) return false;
  return true;
}

function renderSet(setting: Setting): string {
  if (setting.unset) return `unset ${setting.key}`;
  const values = setting.values.map(quoteIfNeeded).join(' ');
  return values.length ? `set ${setting.key} ${values}` : `set ${setting.key}`;
}

function buildEntryBody(entry: ConfigEntry): string[] {
  const out: string[] = [];
  for (const setting of entry.settings.values()) out.push(renderSet(setting));
  for (const child of entry.children) {
    out.push(`config ${serializePath(child.path)}`);
    const body = diffBlockBody(newBlock(child.path), child);
    for (const line of body) out.push(indent(line, 1));
    out.push('end');
  }
  return out;
}

function serializePath(path: string[]): string {
  return path.map(quoteIfNeeded).join(' ');
}

function indent(line: string, n: number): string {
  return '    '.repeat(n) + line;
}

/**
 * Structural comparison of two blocks for read-back verification. Returns a list
 * of human-readable mismatches (or [] if `expected` fully matches `actual` in all
 * settings/entries/nested configs). Ignored fields: insertion order (allowed to
 * differ), setting keys that exist in `actual` but not `expected` (device may add
 * defaults we did not set).
 */
export function compareForVerify(
  path: string[],
  expected: ConfigBlock,
  actual: ConfigBlock | undefined,
): string[] {
  const where = path.join(' ');
  if (!actual) return [`${where}: block missing on device after apply`];
  const mismatches: string[] = [];

  for (const [k, exp] of expected.settings) {
    const act = actual.settings.get(k);
    if (!act) {
      mismatches.push(`${where}: set ${k} was not persisted`);
      continue;
    }
    if (!sameSetting(exp, act)) {
      mismatches.push(
        `${where}: set ${k} = [${exp.values.join(' ')}] expected, but device has [${act.values.join(' ')}]`,
      );
    }
  }

  for (const [name, expEntry] of expected.entries) {
    const actEntry = actual.entries.get(name);
    if (!actEntry) {
      mismatches.push(`${where}: edit ${name} was not persisted`);
      continue;
    }
    mismatches.push(...compareEntry([...path, name], expEntry, actEntry));
  }
  for (const name of actual.entries.keys()) {
    if (!expected.entries.has(name)) {
      mismatches.push(`${where}: unexpected extra edit ${name} still present on device`);
    }
  }

  return mismatches;
}

function compareEntry(path: string[], exp: ConfigEntry, act: ConfigEntry): string[] {
  const where = path.join('/');
  const out: string[] = [];
  for (const [k, expSetting] of exp.settings) {
    const actSetting = act.settings.get(k);
    if (!actSetting) {
      out.push(`${where}: set ${k} was not persisted`);
      continue;
    }
    if (!sameSetting(expSetting, actSetting)) {
      out.push(
        `${where}: set ${k} = [${expSetting.values.join(' ')}] expected, device has [${actSetting.values.join(' ')}]`,
      );
    }
  }
  const expChildren = new Map(exp.children.map((c) => [pathKey(c.path), c]));
  const actChildren = new Map(act.children.map((c) => [pathKey(c.path), c]));
  for (const [k, expChild] of expChildren) {
    const actChild = actChildren.get(k);
    if (!actChild) {
      out.push(`${where}: nested config ${k} was not persisted`);
      continue;
    }
    out.push(...compareForVerify([...path, ...expChild.path], expChild, actChild));
  }
  return out;
}
