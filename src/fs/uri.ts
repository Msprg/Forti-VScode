import * as vscode from 'vscode';
import { ConfigBlock, Document, pathKey } from '../parser';

export const FORTIGATE_SCHEME = 'fortigate';
export const FILE_SUFFIX = '.fcfg';

/**
 * URI layout: `fortigate://<profileId>/<seg1>/<seg2>/...<last>.fcfg`
 *
 * We don't know the depth of a top-level path up front because FortiGate
 * block paths can be 1-N tokens, so we need a pristine Document to
 * disambiguate: we pick the longest prefix of URI segments that matches
 * a known block path, and any remaining single segment is the edit entry name.
 */
export interface FortigateUri {
  profileId: string;
  /** Block path tokens (always at least one). */
  blockPath: string[];
  /** Edit entry name, or undefined if this URI points at the whole block. */
  entryName?: string;
}

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

export function makeGroupUri(profileId: string, groupPath: string[]): vscode.Uri {
  const encoded = groupPath.map(encodeSeg).join('/');
  return vscode.Uri.parse(`${FORTIGATE_SCHEME}://${encodeAuthority(profileId)}/${encoded}`);
}

/**
 * Parse a URI using a pristine document to resolve how many path segments belong
 * to the block path vs the entry name.
 */
export function parseUri(uri: vscode.Uri, doc: Document | undefined): FortigateUri | undefined {
  if (uri.scheme !== FORTIGATE_SCHEME) return undefined;
  const profileId = decodeSeg(uri.authority);
  let pathStr = uri.path.replace(/^\/+/, '');
  if (pathStr.endsWith(FILE_SUFFIX)) pathStr = pathStr.slice(0, -FILE_SUFFIX.length);
  const segments = pathStr.split('/').filter((s) => s.length > 0).map(decodeSeg);
  if (segments.length === 0) {
    return { profileId, blockPath: [] };
  }
  if (!doc) {
    // Fallback: treat the full path as block path (callers should pass doc when possible).
    return { profileId, blockPath: segments };
  }
  // Find the longest prefix that matches a known block path.
  let matched: string[] | undefined;
  for (const block of doc.blocks) {
    if (block.path.length > segments.length) continue;
    const prefix = segments.slice(0, block.path.length);
    if (pathKey(prefix) === pathKey(block.path)) {
      if (!matched || block.path.length > matched.length) matched = block.path.slice();
    }
  }
  if (!matched) {
    // Unknown path; treat entire segments as block path.
    return { profileId, blockPath: segments };
  }
  if (segments.length === matched.length) {
    return { profileId, blockPath: matched };
  }
  if (segments.length === matched.length + 1) {
    return { profileId, blockPath: matched, entryName: segments[matched.length] };
  }
  // More than one extra segment: we don't support nested URIs yet; fall back to block.
  return { profileId, blockPath: matched };
}

export function findBlockInDoc(doc: Document, path: string[]): ConfigBlock | undefined {
  for (const b of doc.blocks) {
    if (pathKey(b.path) === pathKey(path)) return b;
  }
  return undefined;
}

function encodeSeg(s: string): string {
  return encodeURIComponent(s);
}

function encodeAuthority(s: string): string {
  // Authorities are case-insensitive in practice; profileId should be url-safe already.
  return encodeURIComponent(s);
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
