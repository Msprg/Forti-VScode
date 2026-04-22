import * as vscode from 'vscode';
import { ProfileStore, StoredProfile } from '../connection/profileStore';
import { SessionManager } from '../connection/session';
import { StagedChanges } from '../staging/stagedChanges';
import { ConfigTreeProvider, FortiNode } from '../tree/configTreeProvider';
import { FortigateFs } from '../fs/fortigateFs';
import { Logger } from '../util/logger';
import { applyChanges, ApplyMismatchError } from '../commit/applyRunner';
import { build as buildScript } from '../commit/diffEngine';
import { PREVIEW_SCHEME, PreviewProvider, makePreviewUri } from '../commit/previewProvider';
import { makeBlockUri, makeGroupFileUri } from '../fs/uri';

export interface CommandContext {
  profiles: ProfileStore;
  sessions: SessionManager;
  staged: StagedChanges;
  tree: ConfigTreeProvider;
  fs: FortigateFs;
  logger: Logger;
  view: vscode.TreeView<unknown>;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  c: CommandContext,
): void {
  const preview = new PreviewProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, preview),
  );

  const register = (id: string, cb: (...args: any[]) => any): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, cb));
  };

  register('fortigate.addProfile', () => addProfile(c));
  register('fortigate.editProfile', () => editProfile(c));
  register('fortigate.removeProfile', () => removeProfile(c));
  register('fortigate.connect', () => connect(c));
  register('fortigate.disconnect', () => disconnect(c));
  register('fortigate.refreshConfig', () => refreshConfig(c));
  register('fortigate.openNode', (uri: vscode.Uri) => openNode(uri));
  register('fortigate.openWholeSection', (node: FortiNode | vscode.Uri) =>
    openWholeSection(node),
  );
  register('fortigate.openGroup', (node: FortiNode | vscode.Uri) => openGroup(c, node));
  register('fortigate.showPendingChanges', () => showPendingChanges(c, preview));
  register('fortigate.applyChanges', () => applyStaged(c));
  register('fortigate.discardStaged', () => discardStaged(c));
}

async function addProfile(c: CommandContext): Promise<void> {
  const id = await vscode.window.showInputBox({
    prompt: 'Profile id (unique, no spaces)',
    validateInput: (v) => (/^[A-Za-z0-9_.\-]+$/.test(v) ? undefined : 'Use letters, digits, _ . -'),
  });
  if (!id) return;
  if (c.profiles.get(id)) {
    vscode.window.showErrorMessage(`Profile '${id}' already exists.`);
    return;
  }
  const name = await vscode.window.showInputBox({ prompt: 'Display name', value: id });
  if (name === undefined) return;
  const host = await vscode.window.showInputBox({ prompt: 'Host or IP' });
  if (!host) return;
  const portStr = await vscode.window.showInputBox({
    prompt: 'SSH port',
    value: '22',
    validateInput: (v) => (/^\d+$/.test(v) ? undefined : 'Numeric port'),
  });
  if (portStr === undefined) return;
  const username = await vscode.window.showInputBox({ prompt: 'SSH username', value: 'admin' });
  if (!username) return;
  const method = (await vscode.window.showQuickPick(
    [
      { label: 'Password', value: 'password' },
      { label: 'SSH key', value: 'key' },
    ],
    { placeHolder: 'Authentication method' },
  )) as { value: 'password' | 'key' } | undefined;
  if (!method) return;

  const profile: StoredProfile = {
    id,
    name,
    host,
    port: parseInt(portStr, 10),
    username,
    authMethod: method.value,
  };

  if (method.value === 'password') {
    const pw = await vscode.window.showInputBox({
      prompt: `Password for ${username}@${host}`,
      password: true,
      placeHolder: 'Leave empty to be prompted on every connection',
      ignoreFocusOut: true,
    });
    if (pw === undefined) return;
    await c.profiles.upsert(profile);
    if (pw === '') {
      await c.profiles.setPassword(id, undefined);
      vscode.window.showInformationMessage(
        `FortiGate profile '${id}' saved without a password. You will be prompted on each connect.`,
      );
    } else {
      await c.profiles.setPassword(id, pw);
    }
  } else {
    const useFile = await vscode.window.showQuickPick(
      [
        { label: 'Read from file on disk', value: 'file' },
        { label: 'Paste private key content', value: 'paste' },
      ],
      { placeHolder: 'Where is the private key?' },
    );
    if (!useFile) return;
    if (useFile.value === 'file') {
      const keyPath = await vscode.window.showInputBox({
        prompt: 'Path to private key (e.g. ~/.ssh/id_ed25519)',
      });
      if (!keyPath) return;
      profile.privateKeyPath = keyPath;
      await c.profiles.upsert(profile);
    } else {
      const keyText = await vscode.window.showInputBox({
        prompt: 'Paste private key content (will be stored in SecretStorage)',
        password: true,
      });
      if (!keyText) return;
      await c.profiles.upsert(profile);
      await c.profiles.setPrivateKey(id, keyText);
    }
    const passphrase = await vscode.window.showInputBox({
      prompt: 'Key passphrase (leave empty if none)',
      password: true,
    });
    if (passphrase) await c.profiles.setPassphrase(id, passphrase);
  }
  vscode.window.showInformationMessage(`FortiGate profile '${id}' saved.`);
}

async function editProfile(c: CommandContext): Promise<void> {
  const p = await pickProfile(c);
  if (!p) return;
  const action = await vscode.window.showQuickPick(
    [
      { label: 'Update password', value: 'pw' },
      { label: 'Remove saved password (prompt on every connect)', value: 'pw-clear' },
      { label: 'Update private key (paste)', value: 'key' },
      { label: 'Update key passphrase', value: 'pass' },
      { label: 'Edit host/user/port', value: 'conn' },
    ],
    { placeHolder: `Edit profile ${p.id}` },
  );
  if (!action) return;
  switch (action.value) {
    case 'pw': {
      const v = await vscode.window.showInputBox({
        prompt: 'New password (leave empty to be prompted on every connect)',
        password: true,
        ignoreFocusOut: true,
      });
      if (v === undefined) break;
      if (v === '') {
        await c.profiles.setPassword(p.id, undefined);
        vscode.window.showInformationMessage(
          `Saved password cleared for '${p.id}'. You will be prompted on each connect.`,
        );
      } else {
        await c.profiles.setPassword(p.id, v);
      }
      break;
    }
    case 'pw-clear': {
      await c.profiles.setPassword(p.id, undefined);
      vscode.window.showInformationMessage(
        `Saved password cleared for '${p.id}'. You will be prompted on each connect.`,
      );
      break;
    }
    case 'key': {
      const v = await vscode.window.showInputBox({ prompt: 'New private key content', password: true });
      if (v !== undefined) await c.profiles.setPrivateKey(p.id, v);
      break;
    }
    case 'pass': {
      const v = await vscode.window.showInputBox({ prompt: 'New key passphrase', password: true });
      if (v !== undefined) await c.profiles.setPassphrase(p.id, v);
      break;
    }
    case 'conn': {
      const host = await vscode.window.showInputBox({ prompt: 'Host or IP', value: p.host });
      if (host === undefined) return;
      const portStr = await vscode.window.showInputBox({
        prompt: 'SSH port',
        value: String(p.port ?? 22),
      });
      if (portStr === undefined) return;
      const username = await vscode.window.showInputBox({ prompt: 'Username', value: p.username });
      if (username === undefined) return;
      await c.profiles.upsert({
        ...p,
        host,
        port: parseInt(portStr, 10),
        username,
      });
      break;
    }
  }
}

async function removeProfile(c: CommandContext): Promise<void> {
  const p = await pickProfile(c);
  if (!p) return;
  const ok = await vscode.window.showWarningMessage(
    `Remove profile '${p.id}'? Stored credentials will also be deleted.`,
    { modal: true },
    'Remove',
  );
  if (ok !== 'Remove') return;
  await c.profiles.remove(p.id);
}

async function pickProfile(c: CommandContext): Promise<StoredProfile | undefined> {
  const list = c.profiles.list();
  if (list.length === 0) {
    vscode.window.showInformationMessage('No FortiGate profiles. Use "FortiGate: Add Profile".');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((p) => ({ label: p.name ?? p.id, description: `${p.username}@${p.host}:${p.port ?? 22}`, value: p })),
    { placeHolder: 'Pick a FortiGate profile' },
  );
  return picked?.value;
}

async function connect(c: CommandContext): Promise<void> {
  const p = await pickProfile(c);
  if (!p) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${p.name ?? p.id}...` },
    async () => {
      try {
        const session = await c.sessions.connect(p.id);
        await session.showAll();
        c.tree.refresh();
        vscode.window.showInformationMessage(`Connected to FortiGate ${p.name ?? p.id}.`);
      } catch (err) {
        c.logger.error('Connect failed', err);
        vscode.window.showErrorMessage(`Connection failed: ${errorMessage(err)}`);
      }
    },
  );
}

async function disconnect(c: CommandContext): Promise<void> {
  if (c.staged.count() > 0) {
    const ok = await vscode.window.showWarningMessage(
      'You have pending FortiGate changes. Disconnecting will discard them.',
      { modal: true },
      'Disconnect anyway',
    );
    if (ok !== 'Disconnect anyway') return;
  }
  c.staged.clear();
  await c.sessions.disconnect();
}

async function refreshConfig(c: CommandContext): Promise<void> {
  const session = c.sessions.active();
  if (!session) {
    vscode.window.showWarningMessage('No active FortiGate session.');
    return;
  }
  if (c.staged.count() > 0) {
    const ok = await vscode.window.showWarningMessage(
      'Refreshing will drop your staged changes. Continue?',
      { modal: true },
      'Refresh',
    );
    if (ok !== 'Refresh') return;
    c.staged.clear();
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'FortiGate: refreshing configuration' },
    async () => {
      try {
        await session.showAll();
        c.tree.refresh();
      } catch (err) {
        c.logger.error('Refresh failed', err);
        vscode.window.showErrorMessage(`Refresh failed: ${errorMessage(err)}`);
      }
    },
  );
}

async function openNode(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'fortigate-cli');
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * Right-click target on a tabular/singleton block row. Opens the whole
 * `config <path> ... end` section (including every `edit <name>` entry) in a
 * single editor so the user can edit many entries at once and Ctrl+S.
 */
async function openWholeSection(target: FortiNode | vscode.Uri): Promise<void> {
  if (target instanceof vscode.Uri) {
    await openNode(target);
    return;
  }
  if (!target || !target.profileId || !target.path || target.path.length === 0) {
    vscode.window.showWarningMessage('No section to open.');
    return;
  }
  // For both 'block' and 'entry' nodes we point at the enclosing block. For
  // 'group' nodes we fall through to openGroup below when routed there.
  await openNode(makeBlockUri(target.profileId, target.path));
}

/**
 * Right-click target on a group row. Opens a single virtual file containing
 * every `config ... end` block whose path starts with the group prefix. Each
 * block is staged independently when saved.
 */
async function openGroup(
  c: CommandContext,
  target: FortiNode | vscode.Uri,
): Promise<void> {
  if (target instanceof vscode.Uri) {
    await openNode(target);
    return;
  }
  if (!target || target.kind !== 'group') {
    vscode.window.showWarningMessage('Not a group node.');
    return;
  }
  const session = c.sessions.active();
  if (!session) {
    vscode.window.showWarningMessage('No active FortiGate session.');
    return;
  }
  await openNode(makeGroupFileUri(target.profileId, target.path));
}

async function showPendingChanges(
  c: CommandContext,
  preview: PreviewProvider,
): Promise<void> {
  const session = c.sessions.active();
  if (!session) {
    vscode.window.showWarningMessage('No active FortiGate session.');
    return;
  }
  const pristine = session.cachedDocument();
  if (!pristine) {
    vscode.window.showWarningMessage('Configuration not loaded yet.');
    return;
  }
  const composed = c.staged.compose(pristine);
  const script = buildScript(pristine, composed);
  const header =
    '# FortiGate pending-changes preview (generated).\n' +
    '# This script is what "Apply Changes" will send over SSH.\n' +
    (script.isEmpty() ? '# No pending changes.\n' : '\n');
  const body = script.allCommands().join('\n');
  const uri = makePreviewUri(`pending-${Date.now()}`);
  preview.set(uri, header + body + (body ? '\n' : ''));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'fortigate-cli');
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function applyStaged(c: CommandContext): Promise<void> {
  const session = c.sessions.active();
  if (!session) {
    vscode.window.showWarningMessage('No active FortiGate session.');
    return;
  }
  if (c.staged.count() === 0) {
    vscode.window.showInformationMessage('No pending changes.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Apply ${c.staged.count()} staged change set(s) to the live FortiGate?`,
    { modal: true },
    'Apply',
  );
  if (ok !== 'Apply') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'FortiGate: applying and verifying...' },
    async () => {
      try {
        const result = await applyChanges(session, c.staged, c.logger);
        c.tree.refresh();
        vscode.window.showInformationMessage(
          `FortiGate apply succeeded: ${result.commandsSent} command(s), ` +
            `verified ${result.pathsVerified.length} section(s).`,
        );
      } catch (err) {
        c.logger.error('Apply failed', err);
        if (err instanceof ApplyMismatchError) {
          c.logger.show();
          vscode.window.showErrorMessage(
            'Apply completed but read-back verification failed. See "FortiGate" output channel for details.',
          );
        } else {
          vscode.window.showErrorMessage(`Apply failed: ${errorMessage(err)}`);
        }
      }
    },
  );
}

async function discardStaged(c: CommandContext): Promise<void> {
  if (c.staged.count() === 0) return;
  const ok = await vscode.window.showWarningMessage(
    `Discard ${c.staged.count()} staged change(s)?`,
    { modal: true },
    'Discard',
  );
  if (ok !== 'Discard') return;
  c.staged.clear();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
