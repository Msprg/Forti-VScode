import * as vscode from 'vscode';
import { FORTIGATE_SCHEME, parseUri } from '../fs/uri';
import { SessionManager } from '../connection/session';
import { StagedChanges } from '../staging/stagedChanges';
import { pathKey } from '../parser';

/**
 * Adds a subtle badge + color to tree items whose underlying block or entry has
 * staged (unapplied) changes. VS Code plumbs the tree item's `resourceUri` here.
 */
export class TreeDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(
    private readonly sessions: SessionManager,
    private readonly staged: StagedChanges,
  ) {
    staged.onDidChange(() => this.emitter.fire(undefined));
    sessions.onDidChange(() => this.emitter.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== FORTIGATE_SCHEME) return undefined;
    const session = this.sessions.active();
    const doc = session?.cachedDocument();
    const parsed = parseUri(uri, doc);
    if (!parsed) return undefined;

    if (parsed.kind === 'entry') {
      if (this.staged.isEntryModified(parsed.blockPath, parsed.entryName)) {
        return pendingDecoration();
      }
      return undefined;
    }
    if (parsed.kind === 'block') {
      if (this.staged.isPathModified(parsed.blockPath)) {
        return pendingDecoration();
      }
      return undefined;
    }
    // Group: highlight if any block under the prefix is modified.
    for (const o of this.staged.list()) {
      if (hasPathPrefix(o.path, parsed.groupPath)) return pendingDecoration();
    }
    return undefined;
  }
}

function hasPathPrefix(path: string[], prefix: string[]): boolean {
  if (path.length < prefix.length) return false;
  return pathKey(path.slice(0, prefix.length)) === pathKey(prefix);
}

function pendingDecoration(): vscode.FileDecoration {
  return {
    badge: 'M',
    tooltip: 'Has pending FortiGate changes',
    color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
    propagate: true,
  };
}
