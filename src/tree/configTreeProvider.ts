import * as vscode from 'vscode';
import { ConfigBlock, Document, pathKey } from '../parser';
import { SessionManager } from '../connection/session';
import { StagedChanges } from '../staging/stagedChanges';
import { makeBlockUri, makeEntryUri, makeGroupUri } from '../fs/uri';

type NodeKind = 'group' | 'block' | 'entry';

export interface FortiNode {
  kind: NodeKind;
  profileId: string;
  label: string;
  /** For group: the shared path prefix. For block/entry: the block's full path. */
  path: string[];
  /** For entry nodes only. */
  entryName?: string;
  /** Original block reference, populated for block/entry (and group when the group is exactly 1 block deep? No - never). */
  block?: ConfigBlock;
}

/**
 * Builds a browsable hierarchy from the pristine `Document`:
 *   - Top-level nodes are groups of blocks that share the same first path token
 *     (e.g. "system" aggregates "system global", "system interface", ...).
 *   - Inside a group, each distinct block path becomes a node.
 *   - Blocks with table entries expand into one leaf per entry.
 *   - Singleton blocks are leaves.
 */
export class ConfigTreeProvider implements vscode.TreeDataProvider<FortiNode> {
  private readonly emitter = new vscode.EventEmitter<FortiNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly sessions: SessionManager,
    private readonly staged: StagedChanges,
  ) {
    sessions.onDidChange(() => this.refresh());
    staged.onDidChange(() => this.refresh());
  }

  refresh(node?: FortiNode): void {
    this.emitter.fire(node);
  }

  getTreeItem(element: FortiNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label);
    if (element.kind === 'group') {
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.resourceUri = makeGroupUri(element.profileId, element.path);
      item.contextValue = 'fortigate.group';
    } else if (element.kind === 'block') {
      const isTable = (element.block?.entries.size ?? 0) > 0;
      item.collapsibleState = isTable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
      item.iconPath = isTable
        ? new vscode.ThemeIcon('symbol-namespace')
        : new vscode.ThemeIcon('symbol-field');
      item.resourceUri = makeBlockUri(element.profileId, element.path);
      item.contextValue = isTable ? 'fortigate.table' : 'fortigate.singleton';
      if (!isTable) {
        item.command = {
          command: 'fortigate.openNode',
          title: 'Open',
          arguments: [item.resourceUri],
        };
      }
      item.description = isTable
        ? `${element.block!.entries.size} entries`
        : `${element.block?.settings.size ?? 0} settings`;
    } else {
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      item.iconPath = new vscode.ThemeIcon('symbol-key');
      item.resourceUri = makeEntryUri(element.profileId, element.path, element.entryName!);
      item.contextValue = 'fortigate.entry';
      item.command = {
        command: 'fortigate.openNode',
        title: 'Open',
        arguments: [item.resourceUri],
      };
    }
    return item;
  }

  async getChildren(element?: FortiNode): Promise<FortiNode[]> {
    const session = this.sessions.active();
    if (!session) return [];
    const profileId = session.profile.id;
    let doc: Document | undefined = session.cachedDocument();
    if (!doc) {
      try {
        doc = await session.showAll();
      } catch {
        return [];
      }
    }

    if (!element) return this.rootGroups(profileId, doc);

    if (element.kind === 'group') {
      return this.blocksForGroup(profileId, doc, element.path);
    }

    if (element.kind === 'block' && element.block) {
      return this.entriesForBlock(profileId, element);
    }
    return [];
  }

  private rootGroups(profileId: string, doc: Document): FortiNode[] {
    const groups = new Map<string, ConfigBlock[]>();
    for (const block of doc.blocks) {
      const key = block.path[0] ?? '';
      const list = groups.get(key);
      if (list) list.push(block);
      else groups.set(key, [block]);
    }
    const out: FortiNode[] = [];
    for (const [key, blocks] of groups) {
      if (blocks.length === 1 && blocks[0].path.length === 1) {
        out.push({
          kind: 'block',
          profileId,
          label: blocks[0].path.join(' '),
          path: blocks[0].path,
          block: blocks[0],
        });
      } else {
        out.push({
          kind: 'group',
          profileId,
          label: key,
          path: [key],
        });
      }
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  private blocksForGroup(profileId: string, doc: Document, groupPath: string[]): FortiNode[] {
    const prefix = pathKey(groupPath);
    const out: FortiNode[] = [];
    for (const block of doc.blocks) {
      if (block.path.length < groupPath.length) continue;
      if (pathKey(block.path.slice(0, groupPath.length)) !== prefix) continue;
      out.push({
        kind: 'block',
        profileId,
        label: block.path.slice(groupPath.length).join(' ') || block.path.join(' '),
        path: block.path,
        block,
      });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  private entriesForBlock(profileId: string, element: FortiNode): FortiNode[] {
    if (!element.block) return [];
    const out: FortiNode[] = [];
    for (const entry of element.block.entries.values()) {
      out.push({
        kind: 'entry',
        profileId,
        label: entry.name,
        path: element.path,
        entryName: entry.name,
      });
    }
    return out;
  }
}
