import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ProfileStore } from './connection/profileStore';
import { SessionManager } from './connection/session';
import { StagedChanges } from './staging/stagedChanges';
import { ConfigTreeProvider } from './tree/configTreeProvider';
import { FortigateFs, FORTIGATE_SCHEME } from './fs/fortigateFs';
import { StatusBar } from './ui/statusBar';
import { TreeDecorationProvider } from './tree/decorationProvider';
import { Logger } from './util/logger';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger('FortiGate');
  context.subscriptions.push(logger);
  logger.info('Activating FortiGate extension');

  const profiles = new ProfileStore(context);
  const staged = new StagedChanges();
  const sessions = new SessionManager(profiles, logger);
  context.subscriptions.push(staged, sessions);

  const fs = new FortigateFs(sessions, staged);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(FORTIGATE_SCHEME, fs, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
  );

  const tree = new ConfigTreeProvider(sessions, staged);
  const view = vscode.window.createTreeView('fortigateConfig', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  const decorations = new TreeDecorationProvider(sessions, staged);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));

  const statusBar = new StatusBar(sessions, staged);
  context.subscriptions.push(statusBar);

  registerCommands(context, {
    profiles,
    sessions,
    staged,
    tree,
    fs,
    logger,
    view,
  });

  // Reflect connection/pending state to menus via contexts
  const refreshContexts = () => {
    const connected = sessions.activeProfile() !== undefined;
    vscode.commands.executeCommand('setContext', 'fortigate.connected', connected);
    vscode.commands.executeCommand('setContext', 'fortigate.hasPending', staged.count() > 0);
  };
  context.subscriptions.push(
    sessions.onDidChange(refreshContexts),
    staged.onDidChange(refreshContexts),
  );
  refreshContexts();
}

export function deactivate(): void {
  // Sessions are disposed via context.subscriptions
}
