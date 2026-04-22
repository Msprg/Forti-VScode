import * as vscode from 'vscode';
import { SessionManager } from '../connection/session';
import { StagedChanges } from '../staging/stagedChanges';

/**
 * Keeps a single status-bar item in sync with the connection state and the
 * pending-change counter. Clicking it opens the pending-changes preview when
 * there are staged edits, or the connect flow otherwise.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly sessions: SessionManager,
    private readonly staged: StagedChanges,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 500);
    this.subs.push(this.item);
    this.subs.push(sessions.onDidChange(() => this.render()));
    this.subs.push(staged.onDidChange(() => this.render()));
    this.render();
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  private render(): void {
    const profile = this.sessions.activeProfile();
    const count = this.staged.count();
    if (!profile) {
      this.item.text = '$(debug-disconnect) FortiGate';
      this.item.tooltip = 'Click to connect to a FortiGate appliance.';
      this.item.command = 'fortigate.connect';
      return;
    }
    const pending = count > 0 ? `  $(edit) ${count} pending` : '';
    this.item.text = `$(plug) FortiGate: ${profile.name ?? profile.id}${pending}`;
    this.item.tooltip =
      count > 0
        ? 'Click to preview the pending CLI changes.'
        : 'Click to refresh the FortiGate configuration.';
    this.item.command = count > 0 ? 'fortigate.showPendingChanges' : 'fortigate.refreshConfig';
  }
}
