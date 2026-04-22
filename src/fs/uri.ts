import * as vscode from 'vscode';
import { ConfigBlock, Document, pathKey } from '../parser';

export const FORTIGATE_SCHEME = 'fortigate';
export const FILE_SUFFIX = '.fcfg';
export const GROUP_FILE_SUFFIX = '.fgroup';

/**
 * Virtual file kinds:
 *  - `block`: a single `config <path> ... end` section, possibly with entries.
 *  - `entry`: a single `edit <name>` wrapped in its parent `config` section.
 *  - `group`: a concatenation of every block whose path starts with `groupPath`,
 *    e.g. all `system ...` blocks at once.
 */
export type FortigateUri =
  | { kind: 'block'; profileId: string; blockPath: string[] }
  | { kind: 'entry'; profileId: string; blockPath: string[]; entryName: string }
  | { kind: 'group'; profileId: string; groupPath: string[] };

export function makeBlockUri(profileId: string, blockPath: string[]): vscode.Uri {
  const encoded = blockPath.map(encodeSeg).join('/');
  return vscode.Uri.parse(
    `${FORTIGATE_SCHEME}://${encodeAuthority(profileId)}/${encoded}${FILE_SUFFIX}`,
  );
}

export function makeEntryUri(
  profileId: string,
  blockPath: string[],
  entryName: string,
): vscode.Uri {
  const encoded = blockPath.map(encodeSeg).join('/');
  return vscode.Uri.parse(
    `${FORTIGATE_SCHEME}://${encodeAuthority(profileId)}/${encoded}/${encodeSeg(entryName)}${FILE_SUFFIX}`,
  );
}

/**
 * URI used purely as a tree-item resource for group rows; does NOT resolve to a
 * file. For a group-scoped editable file use `makeGroupFileUri` instead.
 */
export function makeGroupUri(profileId: string, groupPath: string[]): vscode.Uri {
  const encoded = groupPath.map(encodeSeg).join('/');
  return vscode.Uri.parse(`${FORTIGATE_SCHEME}://${encodeAuthority(profileId)}/${encoded}`);
}

export function makeGroupFileUri(profileId: string, groupPath: string[]): vscode.Uri {
  const encoded = groupPath.map(encodeSeg).join('/');
  return vscode.Uri.parse(
    `${FORTIGATE_SCHEME}://${encodeAuthority(profileId)}/${encoded}${GROUP_FILE_SUFFIX}`,
  );
}

/**
 * Parse a URI using a pristine document to resolve how many path segments belong
 * to the block path vs the entry name. Group URIs (ending in `.fgroup`) are
 * recognised first and returned with their full `groupPath`.
 */
export function parseUri(
  uri: vscode.Uri,
  doc: Document | undefined,
): FortigateUri | undefined {
  if (uri.scheme !== FORTIGATE_SCHEME) return undefined;
  const profileId = decodeSeg(uri.authority);
  let pathStr = uri.path.replace(/^\/+/, '');
  let isGroup = false;
  if (pathStr.endsWith(GROUP_FILE_SUFFIX)) {
    pathStr = pathStr.slice(0, -GROUP_FILE_SUFFIX.length);
    isGroup = true;
  } else if (pathStr.endsWith(FILE_SUFFIX)) {
    pathStr = pathStr.slice(0, -FILE_SUFFIX.length);
  }
  const segments = pathStr.split('/').filter((s) => s.length > 0).map(decodeSeg);
  if (segments.length === 0) {
    return { kind: 'block', profileId, blockPath: [] };
  }
  if (isGroup) {
    return { kind: 'group', profileId, groupPath: segments };
  }
  if (!doc) {
    return { kind: 'block', profileId, blockPath: segments };
  }
  let matched: string[] | undefined;
  for (const block of doc.blocks) {
    if (block.path.length > segments.length) continue;
    const prefix = segments.slice(0, block.path.length);
    if (pathKey(prefix) === pathKey(block.path)) {
      if (!matched || block.path.length > matched.length) matched = block.path.slice();
    }
  }
  if (!matched) {
    return { kind: 'block', profileId, blockPath: segments };
  }
  if (segments.length === matched.length) {
    return { kind: 'block', profileId, blockPath: matched };
  }
  if (segments.length === matched.length + 1) {
    return {
      kind: 'entry',
      profileId,
      blockPath: matched,
      entryName: segments[matched.length],
    };
  }
  return { kind: 'block', profileId, blockPath: matched };
}

export function findBlockInDoc(doc: Document, path: string[]): ConfigBlock | undefined {
  for (const b of doc.blocks) {
    if (pathKey(b.path) === pathKey(path)) return b;
  }
  return undefined;
}

/** Return all blocks in `doc` whose path starts with `groupPath`. */
export function findBlocksInGroup(doc: Document, groupPath: string[]): ConfigBlock[] {
  const prefix = pathKey(groupPath);
  const out: ConfigBlock[] = [];
  for (const block of doc.blocks) {
    if (block.path.length < groupPath.length) continue;
    if (pathKey(block.path.slice(0, groupPath.length)) === prefix) out.push(block);
  }
  return out;
}

function encodeSeg(s: string): string {
  return encodeURIComponent(s);
}

function encodeAuthority(s: string): string {
  return encodeURIComponent(s);
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
