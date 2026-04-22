import * as vscode from 'vscode';
import { Document, parse } from '../parser';
import { Logger } from '../util/logger';
import { ProfileStore, ResolvedProfile } from './profileStore';
import { SshClient } from './sshClient';

/**
 * Wraps a single SSH connection to a FortiGate and exposes the few high-level
 * operations the rest of the extension needs: fetch full config, fetch a subtree,
 * run a script, disconnect.
 *
 * The session is self-healing: every public operation first calls
 * `ensureConnected()` which re-establishes the SSH shell if it has been dropped
 * (FortiGate's `admintimeout` kills idle CLI sessions after ~5 minutes by
 * default). In addition we send a lightweight `get system status` keepalive
 * every `keepaliveMs` so an idle editor never hits the admin timeout in the
 * first place.
 */
export class FortigateSession implements vscode.Disposable {
  private ssh: SshClient | undefined;
  private cached: Document | undefined;
  private keepaliveTimer: NodeJS.Timeout | undefined;
  /** Default FortiOS `admintimeout` is 5 minutes; ping more often than that. */
  private readonly keepaliveMs = 3 * 60 * 1000;
  private reconnecting = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever the underlying SSH connection state may have changed. */
  readonly onDidChangeConnection = this.emitter.event;

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
    const ssh = new SshClient({
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
    ssh.onClose(() => {
      // The remote (or the network) closed the channel. Drop our handle so the
      // next operation triggers a full reconnect.
      if (this.ssh === ssh) {
        this.logger.warn('FortiGate SSH channel closed unexpectedly');
        this.ssh = undefined;
        this.clearKeepalive();
        this.emitter.fire();
      }
    });
    this.ssh = ssh;
    await ssh.connect();
    await this.disablePaging();
    this.scheduleKeepalive();
    this.emitter.fire();
  }

  async disconnect(): Promise<void> {
    this.clearKeepalive();
    const old = this.ssh;
    this.ssh = undefined;
    this.cached = undefined;
    if (old) {
      try {
        await old.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
    void this.disconnect();
  }

  /** Fetch the full `show` and parse into a Document. */
  async showAll(): Promise<Document> {
    return this.runWithReconnect(
      async () => {
        // Paging is disabled on connect via `config system console / set output standard`.
        // We avoid `| no-more` here: not all FortiOS versions support that pipe.
        const text = await this.ssh!.runCommand('show');
        const doc = parse(text);
        this.cached = doc;
        return doc;
      },
      { retryOnDropMidCommand: true },
    );
  }

  /**
   * Fetch `show <path...>` for a single top-level path, parse and return the
   * resulting document (or an empty one if the block does not exist).
   */
  async showPath(path: string[]): Promise<Document> {
    return this.runWithReconnect(
      async () => {
        const text = await this.ssh!.runCommand(`show ${path.join(' ')}`);
        return parse(text);
      },
      { retryOnDropMidCommand: true },
    );
  }

  /**
   * Execute a script as-is. Reconnects first if the session has been dropped,
   * but never retries mid-flight because individual commands may have already
   * been applied on the device.
   */
  async runScript(lines: string[]): Promise<string> {
    return this.runWithReconnect(async () => this.ssh!.runScript(lines), {
      retryOnDropMidCommand: false,
    });
  }

  /** Get the last cached Document from showAll(), if any. */
  cachedDocument(): Document | undefined {
    return this.cached;
  }

  /**
   * Ensure the SSH session is up, then run `fn`. Pre-emptive reconnects are
   * always safe (nothing has been written yet). Mid-flight drops are only
   * retried for idempotent read operations: `runScript` opts out because
   * earlier commands in a batch may already have taken effect on the device.
   */
  private async runWithReconnect<T>(
    fn: () => Promise<T>,
    opts: { retryOnDropMidCommand: boolean },
  ): Promise<T> {
    await this.ensureConnected();
    try {
      const result = await fn();
      this.scheduleKeepalive();
      return result;
    } catch (err) {
      if (!opts.retryOnDropMidCommand || !isConnectionError(err) || this.reconnecting) {
        throw err;
      }
      this.logger.warn('FortiGate session dropped mid-command; reconnecting and retrying once', err);
      await this.hardReset();
      await this.ensureConnected();
      const result = await fn();
      this.scheduleKeepalive();
      return result;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.ssh?.isConnected) return;
    if (this.reconnecting) {
      // Wait for the ongoing reconnect to finish.
      while (this.reconnecting) await sleep(50);
      if (this.ssh?.isConnected) return;
    }
    this.reconnecting = true;
    try {
      await this.hardReset();
      this.logger.info('Reconnecting to FortiGate...');
      await this.connect();
    } finally {
      this.reconnecting = false;
    }
  }

  private async hardReset(): Promise<void> {
    this.clearKeepalive();
    const old = this.ssh;
    this.ssh = undefined;
    if (old) {
      try {
        await old.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.emitter.fire();
  }

  /**
   * Tell the console to emit the full output without paging so `show` returns
   * everything in a single buffer. Non-fatal: if it fails, a very large config
   * may still be truncated at the --More-- pager.
   */
  private async disablePaging(): Promise<void> {
    if (!this.ssh?.isConnected) return;
    try {
      await this.ssh.runScript(['config system console', 'set output standard', 'end']);
    } catch (err) {
      this.logger.warn('Could not disable console paging', err);
    }
  }

  /**
   * Reset the CLI-level keepalive timer. The timer fires a trivial command
   * (`get system status`) just before FortiGate's default 5-minute
   * `admintimeout` would kill the shell, which resets the timeout server-side.
   */
  private scheduleKeepalive(): void {
    this.clearKeepalive();
    this.keepaliveTimer = setTimeout(() => {
      void this.sendKeepalive();
    }, this.keepaliveMs);
    // Node setTimeout keeps the event loop alive; `.unref()` so the extension
    // host can exit cleanly if everything else is idle.
    this.keepaliveTimer.unref?.();
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  private async sendKeepalive(): Promise<void> {
    if (!this.ssh?.isConnected || this.reconnecting) return;
    try {
      await this.ssh.runCommand('get system status');
      this.logger.debug('FortiGate keepalive ok');
      this.scheduleKeepalive();
    } catch (err) {
      this.logger.warn('FortiGate keepalive failed; session will be reconnected on next use', err);
      await this.hardReset();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message ?? '';
  return (
    m.includes('FortiGate session is not connected') ||
    m.includes('SSH channel is not open') ||
    m.includes('SSH channel closed') ||
    m.includes('Timed out after') ||
    m.includes('ECONNRESET') ||
    m.includes('ECONNREFUSED') ||
    m.includes('ETIMEDOUT') ||
    m.includes('socket hang up') ||
    m.includes('Client network socket disconnected') ||
    m.includes('Connection lost') ||
    /Not connected/i.test(m)
  );
}

/**
 * Single active session at a time. Future work: map-of-sessions for multi-connect.
 */
export class SessionManager implements vscode.Disposable {
  private session: FortigateSession | undefined;
  private sessionSub: vscode.Disposable | undefined;
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
    if (this.session) {
      await this.disconnect();
    }
    const profile = await this.profiles.resolve(profileId);
    if ((profile.authMethod ?? 'password') === 'password' && profile.password === undefined) {
      const pw = await vscode.window.showInputBox({
        prompt: `Password for ${profile.username}@${profile.host}`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'No password is saved for this profile — enter it for this session',
      });
      if (pw === undefined) {
        throw new Error('FortiGate connect cancelled: no password provided.');
      }
      // Kept in memory on the session only. Auto-reconnect reuses the same
      // value; a fresh `SessionManager.connect()` (e.g. after disconnect) will
      // re-resolve from SecretStorage and re-prompt again.
      profile.password = pw;
    }
    const session = new FortigateSession(profile, this.logger);
    this.sessionSub = session.onDidChangeConnection(() => this.emitter.fire(session));
    await session.connect();
    this.session = session;
    this.emitter.fire(session);
    return session;
  }

  async disconnect(): Promise<void> {
    const s = this.session;
    this.session = undefined;
    this.sessionSub?.dispose();
    this.sessionSub = undefined;
    if (s) {
      await s.disconnect();
      this.emitter.fire(undefined);
    }
  }

  dispose(): void {
    this.sessionSub?.dispose();
    void this.disconnect();
    this.emitter.dispose();
  }
}
