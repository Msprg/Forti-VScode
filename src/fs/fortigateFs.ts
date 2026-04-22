import * as vscode from 'vscode';
import {
  Document,
  findBlock,
  newBlock,
  parse,
  serializeBlock,
} from '../parser';
import { SessionManager } from '../connection/session';
import { StagedChanges } from '../staging/stagedChanges';
import { parseUri, FORTIGATE_SCHEME, FILE_SUFFIX } from './uri';

export { FORTIGATE_SCHEME } from './uri';

const BLOCK_FILE_HEADER =
  '# FortiGate staged view. Edits are captured on save and only sent to the\n' +
  '# device when you run "FortiGate: Apply Changes".\n';

/**
 * Virtual file system backing `fortigate://` URIs.
 *
 * - `readFile` renders either a whole `config <path> ... end` block or a single
 *   `edit <name> ... next` wrapped in its enclosing `config` block, pulling the
 *   content from the current staged overlay (falling back to pristine).
 * - `writeFile` re-parses the buffer, extracts the relevant subtree and stores it
 *   as a staged override.
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
    const session = this.sessions.active();
    const doc = session?.cachedDocument();
    const parsed = parseUri(uri, doc);
    if (!parsed || parsed.blockPath.length === 0) {
      // Directory root
      return this.directoryStat();
    }
    // If URI ends with .fcfg we treat as a file.
    if (uri.path.endsWith(FILE_SUFFIX)) return this.fileStat(this.readContent(uri).length);
    return this.directoryStat();
  }

  readDirectory(): [string, vscode.FileType][] {
    // We don't support directory listing via VS Code; tree view is the UI.
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
    if (!parsed || parsed.blockPath.length === 0) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const text = Buffer.from(content).toString('utf8');
    const newDoc: Document = parse(text);
    const newBlockNode = findBlock(newDoc, parsed.blockPath);
    if (!newBlockNode) {
      throw vscode.FileSystemError.Unavailable(
        `Saved buffer did not contain a \`config ${parsed.blockPath.join(' ')}\` block. ` +
          `Do not remove the enclosing config header.`,
      );
    }

    if (parsed.entryName !== undefined) {
      const entry = newBlockNode.entries.get(parsed.entryName);
      if (!entry) {
        throw vscode.FileSystemError.Unavailable(
          `Saved buffer did not contain \`edit ${parsed.entryName}\`. ` +
            `Keep the edit header if you want to change this entry.`,
        );
      }
      this.staged.set({ kind: 'entry', path: parsed.blockPath.slice(), name: parsed.entryName, entry });
    } else {
      this.staged.set({ kind: 'block', path: parsed.blockPath.slice(), block: newBlockNode });
    }

    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(uri: vscode.Uri): void {
    const session = this.sessions.active();
    const doc = session?.cachedDocument();
    const parsed = parseUri(uri, doc);
    if (!parsed || parsed.blockPath.length === 0) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    // "Delete" here means: drop any staged override, which reverts to pristine.
    if (parsed.entryName !== undefined) {
      this.staged.delete({ kind: 'entry', path: parsed.blockPath, name: parsed.entryName });
    } else {
      this.staged.delete({ kind: 'block', path: parsed.blockPath });
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Rename not supported on fortigate://');
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
    if (!parsed || parsed.blockPath.length === 0) {
      return '# Unknown path.\n';
    }
    const block = findBlock(composed, parsed.blockPath);
    if (!block) {
      return BLOCK_FILE_HEADER + `# Path \`${parsed.blockPath.join(' ')}\` not present in current config.\n`;
    }
    const lines: string[] = [];
    if (parsed.entryName !== undefined) {
      const entry = block.entries.get(parsed.entryName);
      if (!entry) {
        return (
          BLOCK_FILE_HEADER +
          `# Entry \`${parsed.entryName}\` not present in \`${parsed.blockPath.join(' ')}\`.\n`
        );
      }
      // Wrap the single entry in its enclosing config so the buffer is valid CLI.
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
