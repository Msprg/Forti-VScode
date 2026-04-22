import * as vscode from 'vscode';
import { Document, parse } from '../parser';
import { Logger } from '../util/logger';
import { ProfileStore, ResolvedProfile } from './profileStore';
import { SshClient } from './sshClient';

/**
 * Wraps a single SSH connection to a FortiGate and exposes the few high-level
 * operations the rest of the extension needs: fetch full config, fetch a subtree,
 * run a script, disconnect.
 */
export class FortigateSession implements vscode.Disposable {
  private ssh: SshClient | undefined;
  private cached: Document | undefined;

  constructor(
    public readonly profile: ResolvedProfile,
    private readonly logger: Logger,
  ) {}

  get connected(): boolean {
    return this.ssh?.isConnected ?? false;
  }

  async connect(): Promise<void> {
    if (this.ssh?.isConnected) return;
    const cfg = vscode.workspace.getConfiguration('fortigate');
    const promptRegexStr = cfg.get<string>('readyPromptRegex');
    const timeout = cfg.get<number>('commandTimeoutMs');
    this.ssh = new SshClient({
      host: this.profile.host,
      port: this.profile.port,
      auth: {
        username: this.profile.username,
        password: this.profile.password,
        privateKey: this.profile.privateKey,
        passphrase: this.profile.passphrase,
      },
      hostKeyFingerprint: this.profile.hostKeyFingerprint,
      promptRegex: promptRegexStr ? new RegExp(promptRegexStr) : undefined,
      commandTimeoutMs: timeout,
      logger: this.logger,
    });
    await this.ssh.connect();
    await this.disablePaging();
  }

  async disconnect(): Promise<void> {
    await this.ssh?.disconnect();
    this.ssh = undefined;
    this.cached = undefined;
  }

  dispose(): void {
    void this.disconnect();
  }

  /** Fetch the full `show` and parse into a Document. */
  async showAll(): Promise<Document> {
    const ssh = this.requireSsh();
    // Paging is disabled on connect via `config system console / set output standard`.
    // We avoid `| no-more` here: not all FortiOS versions support that pipe.
    const text = await ssh.runCommand('show');
    const doc = parse(text);
    this.cached = doc;
    return doc;
  }

  /**
   * Fetch `show <path...>` for a single top-level path, parse and return the single
   * resulting block (or undefined if it does not exist).
   */
  async showPath(path: string[]): Promise<Document> {
    const ssh = this.requireSsh();
    const text = await ssh.runCommand(`show ${path.join(' ')}`);
    return parse(text);
  }

  /** Execute a script as-is. Caller is responsible for command correctness. */
  async runScript(lines: string[]): Promise<string> {
    const ssh = this.requireSsh();
    return ssh.runScript(lines);
  }

  /** Get the last cached Document from showAll(), if any. */
  cachedDocument(): Document | undefined {
    return this.cached;
  }

  private requireSsh(): SshClient {
    if (!this.ssh?.isConnected) {
      throw new Error('FortiGate session is not connected');
    }
    return this.ssh;
  }

  /**
   * Tell the console to emit the full output without paging so `show` returns
   * everything in a single buffer. Non-fatal: if it fails, a very large config
   * may still be truncated at the --More-- pager.
   */
  private async disablePaging(): Promise<void> {
    const ssh = this.requireSsh();
    try {
      await ssh.runScript(['config system console', 'set output standard', 'end']);
    } catch (err) {
      this.logger.warn('Could not disable console paging', err);
    }
  }
}

/**
 * Single active session at a time. Future work: map-of-sessions for multi-connect.
 */
export class SessionManager implements vscode.Disposable {
  private session: FortigateSession | undefined;
  private readonly emitter = new vscode.EventEmitter<FortigateSession | undefined>();

  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly profiles: ProfileStore,
    private readonly logger: Logger,
  ) {}

  activeProfile(): ResolvedProfile | undefined {
    return this.session?.profile;
  }

  active(): FortigateSession | undefined {
    return this.session;
  }

  async connect(profileId: string): Promise<FortigateSession> {
    if (this.session?.connected) {
      await this.disconnect();
    }
    const profile = await this.profiles.resolve(profileId);
    const session = new FortigateSession(profile, this.logger);
    await session.connect();
    this.session = session;
    this.emitter.fire(session);
    return session;
  }

  async disconnect(): Promise<void> {
    const s = this.session;
    this.session = undefined;
    if (s) {
      await s.disconnect();
      this.emitter.fire(undefined);
    }
  }

  dispose(): void {
    void this.disconnect();
    this.emitter.dispose();
  }
}
