import * as vscode from 'vscode';

export const PREVIEW_SCHEME = 'fortigate-preview';

/**
 * Virtual document provider for `fortigate-preview://` URIs used to show the
 * pending-changes CLI script in a read-only editor.
 */
export class PreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  private readonly contents = new Map<string, string>();

  set(uri: vscode.Uri, text: string): void {
    this.contents.set(uri.toString(), text);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '# No content.\n';
  }
}

export function makePreviewUri(label: string): vscode.Uri {
  const safe = encodeURIComponent(label.replace(/\s+/g, '-'));
  return vscode.Uri.parse(`${PREVIEW_SCHEME}:/${safe}.fcfg`);
}
