import * as vscode from 'vscode';
import {
  Document,
  findBlock,
  newBlock,
  parse,
  pathKey,
  serializeBlock,
} from '../parser';
import { SessionManager } from '../connection/session';
import { StagedChanges } from '../staging/stagedChanges';
import {
  FORTIGATE_SCHEME,
  FILE_SUFFIX,
  GROUP_FILE_SUFFIX,
  findBlocksInGroup,
  parseUri,
} from './uri';

export { FORTIGATE_SCHEME } from './uri';

const BLOCK_FILE_HEADER =
  '# FortiGate staged view. Edits are captured on save and only sent to the\n' +
  '# device when you run "FortiGate: Apply Changes".\n';

const GROUP_FILE_HEADER =
  '# FortiGate group view: every config block whose path starts with this prefix\n' +
  '# is shown below. You can edit multiple `config ... end` sections in one buffer\n' +
  '# and Ctrl+S stages each section independently.\n';

/**
 * Virtual file system backing `fortigate://` URIs.
 *
 * - `readFile` renders one of three kinds of buffer:
 *   - a whole `config <path> ... end` block (block URI),
 *   - a single `edit <name>` wrapped in its enclosing `config` block (entry URI), or
 *   - a concatenation of every block under a path prefix (group URI, `.fgroup`).
 * - `writeFile` re-parses the buffer and stages each top-level section contained
 *   in it as a block override (or single entry for entry URIs).
 *
 * All files are virtual; there is no on-disk representation.
 */
export class FortigateFs implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(
    private readonly sessions: SessionManager,
    private readonly staged: StagedChanges,
  ) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.path.endsWith(FILE_SUFFIX) || uri.path.endsWith(GROUP_FILE_SUFFIX)) {
      return this.fileStat(this.readContent(uri).length);
    }
    return this.directoryStat();
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Cannot create directories in fortigate://');
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const text = this.readContent(uri);
    return Buffer.from(text, 'utf8');
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): void {
    const session = this.sessions.active();
    if (!session) {
      throw vscode.FileSystemError.Unavailable('No active FortiGate session');
    }
    const doc = session.cachedDocument();
    if (!doc) {
      throw vscode.FileSystemError.Unavailable('FortiGate configuration has not been loaded yet');
    }
    const parsed = parseUri(uri, doc);
    if (!parsed) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const text = Buffer.from(content).toString('utf8');
    const newDoc: Document = parse(text);

    if (parsed.kind === 'group') {
      this.stageGroup(parsed.groupPath, newDoc);
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      return;
    }

    if (parsed.blockPath.length === 0) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const newBlockNode = findBlock(newDoc, parsed.blockPath);
    if (!newBlockNode) {
      throw vscode.FileSystemError.Unavailable(
        `Saved buffer did not contain a \`config ${parsed.blockPath.join(' ')}\` block. ` +
          `Do not remove the enclosing config header.`,
      );
    }

    if (parsed.kind === 'entry') {
      const entry = newBlockNode.entries.get(parsed.entryName);
      if (!entry) {
        throw vscode.FileSystemError.Unavailable(
          `Saved buffer did not contain \`edit ${parsed.entryName}\`. ` +
            `Keep the edit header if you want to change this entry.`,
        );
      }
      this.staged.set({
        kind: 'entry',
        path: parsed.blockPath.slice(),
        name: parsed.entryName,
        entry,
      });
    } else {
      this.staged.set({ kind: 'block', path: parsed.blockPath.slice(), block: newBlockNode });
    }

    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(uri: vscode.Uri): void {
    const session = this.sessions.active();
    const doc = session?.cachedDocument();
    const parsed = parseUri(uri, doc);
    if (!parsed) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (parsed.kind === 'entry') {
      this.staged.delete({ kind: 'entry', path: parsed.blockPath, name: parsed.entryName });
    } else if (parsed.kind === 'block') {
      this.staged.delete({ kind: 'block', path: parsed.blockPath });
    } else {
      // Group: drop all block overrides under this prefix.
      const groupPath = parsed.groupPath;
      for (const o of this.staged.list()) {
        if (o.path.length < groupPath.length) continue;
        if (pathKey(o.path.slice(0, groupPath.length)) !== pathKey(groupPath)) continue;
        this.staged.delete(
          o.kind === 'block'
            ? { kind: 'block', path: o.path }
            : { kind: 'entry', path: o.path, name: o.name },
        );
      }
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Rename not supported on fortigate://');
  }

  /**
   * Stage every top-level block in `newDoc` that falls under `groupPath` as a
   * block-level override. Blocks not belonging to the group are silently ignored
   * to guard against the user accidentally including unrelated content.
   */
  private stageGroup(groupPath: string[], newDoc: Document): void {
    const prefix = pathKey(groupPath);
    const seen = new Set<string>();
    for (const block of newDoc.blocks) {
      if (block.path.length < groupPath.length) continue;
      const p = pathKey(block.path.slice(0, groupPath.length));
      if (p !== prefix) continue;
      this.staged.set({ kind: 'block', path: block.path.slice(), block });
      seen.add(pathKey(block.path));
    }
    // If a block that was visible in the pristine group is now missing from the
    // saved buffer, fall back to staging an empty block so the diff engine can
    // emit `purge`-style deletes. (Rare; requires the user to intentionally
    // remove a whole `config ... end` section.)
    const session = this.sessions.active();
    const pristine = session?.cachedDocument();
    if (pristine) {
      for (const block of pristine.blocks) {
        if (block.path.length < groupPath.length) continue;
        if (pathKey(block.path.slice(0, groupPath.length)) !== prefix) continue;
        if (seen.has(pathKey(block.path))) continue;
        const empty = newBlock(block.path);
        this.staged.set({ kind: 'block', path: block.path.slice(), block: empty });
      }
    }
  }

  /**
   * Compose the text shown in the editor for a given URI: pristine + staged overlay,
   * rendered as standalone FortiGate CLI so that saving the buffer back round-trips.
   */
  private readContent(uri: vscode.Uri): string {
    const session = this.sessions.active();
    if (!session) return '# No active FortiGate session.\n';
    const pristine = session.cachedDocument();
    if (!pristine) return '# Configuration not loaded. Run "FortiGate: Refresh Configuration".\n';
    const composed = this.staged.compose(pristine);
    const parsed = parseUri(uri, pristine) ?? parseUri(uri, composed);
    if (!parsed) return '# Unknown path.\n';

    const lines: string[] = [];
    if (parsed.kind === 'group') {
      const blocks = findBlocksInGroup(composed, parsed.groupPath);
      if (blocks.length === 0) {
        return (
          GROUP_FILE_HEADER +
          `# No blocks match prefix \`${parsed.groupPath.join(' ')}\` in the current config.\n`
        );
      }
      lines.push(GROUP_FILE_HEADER.trimEnd());
      for (const b of blocks) {
        serializeBlock(b, 0, lines);
      }
      return lines.join('\n') + '\n';
    }

    if (parsed.blockPath.length === 0) return '# Unknown path.\n';
    const block = findBlock(composed, parsed.blockPath);
    if (!block) {
      return (
        BLOCK_FILE_HEADER +
        `# Path \`${parsed.blockPath.join(' ')}\` not present in current config.\n`
      );
    }

    if (parsed.kind === 'entry') {
      const entry = block.entries.get(parsed.entryName);
      if (!entry) {
        return (
          BLOCK_FILE_HEADER +
          `# Entry \`${parsed.entryName}\` not present in \`${parsed.blockPath.join(' ')}\`.\n`
        );
      }
      const shell = newBlock(parsed.blockPath);
      shell.entries.set(parsed.entryName, entry);
      lines.push(BLOCK_FILE_HEADER.trimEnd());
      serializeBlock(shell, 0, lines);
      return lines.join('\n') + '\n';
    }

    lines.push(BLOCK_FILE_HEADER.trimEnd());
    serializeBlock(block, 0, lines);
    return lines.join('\n') + '\n';
  }

  private directoryStat(): vscode.FileStat {
    return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
  }

  private fileStat(size: number): vscode.FileStat {
    const now = Date.now();
    return { type: vscode.FileType.File, ctime: now, mtime: now, size };
  }
}
