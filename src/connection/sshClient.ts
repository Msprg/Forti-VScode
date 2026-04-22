import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { Logger } from '../util/logger';

export interface SshAuth {
  username: string;
  password?: string;
  privateKey?: Buffer | string;
  passphrase?: string;
}

export interface SshClientOptions {
  host: string;
  port?: number;
  auth: SshAuth;
  /** Pinned SHA256 fingerprint (base64, without any colon formatting) for host key verification. */
  hostKeyFingerprint?: string;
  /** Regex used to detect the appliance prompt. Defaults to `<hostname>[ (vdom)] #` at end of buffer. */
  promptRegex?: RegExp;
  /** Command timeout in milliseconds. */
  commandTimeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_PROMPT =
  /\r?\n?([A-Za-z0-9_.\-]+)(?:\s*\([^)]*\))?\s*[#$]\s*$/;

const ERROR_PATTERNS: RegExp[] = [
  /Command fail\.\s+Return code\s+-?\d+/i,
  /command parse error/i,
  /Unknown action\s+\d+/i,
  /CLI Parsing Error/i,
  /entry not found in datasource/i,
  /object (does not exist|already exists)/i,
  /attribute '.*' MUST be set/i,
  /Permission denied/i,
];

export class CommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly output: string,
    public readonly matched: string,
  ) {
    super(`FortiGate command failed: ${command}\n  matched: ${matched}\n  output:\n${output}`);
  }
}

export class SshTimeoutError extends Error {
  constructor(public readonly command: string, public readonly ms: number) {
    super(`Timed out after ${ms}ms waiting for FortiGate prompt after: ${command}`);
  }
}

/**
 * Low-level SSH shell wrapper for a FortiGate CLI session.
 *
 * The class owns a single interactive shell channel and serialises commands
 * through it by detecting the device prompt at the end of the output buffer.
 * It is intentionally minimal and not FortiGate-semantics aware; higher-level
 * work (disable paging, show/apply) lives in `FortigateSession`.
 */
export class SshClient {
  private client: Client | undefined;
  private channel: ClientChannel | undefined;
  private buffer = '';
  private pending: Promise<unknown> = Promise.resolve();
  private promptRegex: RegExp;
  private readonly commandTimeoutMs: number;
  private readonly logger?: Logger;
  private connected = false;
  private closeHandlers: Array<() => void> = [];

  constructor(private readonly options: SshClientOptions) {
    this.promptRegex = options.promptRegex ?? DEFAULT_PROMPT;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.logger = options.logger;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  async connect(): Promise<void> {
    const client = new Client();
    this.client = client;
    const { auth, host, port } = this.options;

    const cfg: ConnectConfig = {
      host,
      port: port ?? 22,
      username: auth.username,
      readyTimeout: 15_000,
      keepaliveInterval: 15_000,
      tryKeyboard: false,
      algorithms: {
        // Broaden algorithm lists; older FortiGate versions still negotiate legacy ciphers.
        serverHostKey: [
          'ssh-ed25519',
          'ecdsa-sha2-nistp256',
          'ecdsa-sha2-nistp384',
          'ecdsa-sha2-nistp521',
          'rsa-sha2-512',
          'rsa-sha2-256',
          'ssh-rsa',
        ],
      },
    };
    if (auth.password !== undefined) cfg.password = auth.password;
    if (auth.privateKey !== undefined) {
      cfg.privateKey = auth.privateKey;
      if (auth.passphrase) cfg.passphrase = auth.passphrase;
    }

    if (this.options.hostKeyFingerprint) {
      const expected = normaliseFingerprint(this.options.hostKeyFingerprint);
      // ssh2's runtime passes a Buffer here; @types/ssh2 narrows to string which
      // is not quite right, so we accept both and SHA256 whatever we get.
      const verify = (key: Buffer | string): boolean => {
        const keyBuffer = typeof key === 'string' ? Buffer.from(key) : key;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { createHash } = require('crypto') as typeof import('crypto');
        const fp = createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
        const match = fp === expected;
        if (!match) this.logger?.warn('Host key fingerprint mismatch', { expected, actual: fp });
        return match;
      };
      (cfg as { hostVerifier?: (key: unknown) => boolean }).hostVerifier = verify as (
        key: unknown,
      ) => boolean;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      client.on('ready', () => {
        client.shell({ term: 'xterm' }, (err, ch) => {
          if (err) return done(err);
          this.channel = ch;
          ch.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString('utf8');
          });
          ch.stderr.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString('utf8');
          });
          ch.on('close', () => this.handleClose());
          done();
        });
      });
      client.on('error', (err) => done(err));
      client.on('end', () => this.handleClose());
      client.on('close', () => this.handleClose());
      client.connect(cfg);
    });

    // Wait for the initial prompt before returning. If we see a banner first, keep waiting.
    await this.waitForPrompt('<initial banner>');
    this.buffer = '';
    this.connected = true;
  }

  /**
   * Send `command` and wait until the prompt reappears. Returns the command output
   * with the echoed command line and trailing prompt stripped. Throws on matched
   * error patterns.
   */
  runCommand(command: string): Promise<string> {
    return this.enqueue(async () => {
      this.assertChannel();
      this.buffer = '';
      this.channel!.write(command + '\n');
      await this.waitForPrompt(command);
      const output = extractCommandOutput(this.buffer, command, this.promptRegex);
      this.buffer = '';
      const err = findError(output);
      if (err) throw new CommandError(command, output, err);
      return output;
    });
  }

  /**
   * Run each command in order, stopping at the first error. Returns concatenated output.
   * Caller is responsible for wrapping transactional sequences in `config`/`end`.
   */
  runScript(lines: string[]): Promise<string> {
    return this.enqueue(async () => {
      let combined = '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        this.assertChannel();
        this.buffer = '';
        this.channel!.write(line + '\n');
        await this.waitForPrompt(line);
        const out = extractCommandOutput(this.buffer, line, this.promptRegex);
        this.buffer = '';
        const err = findError(out);
        if (err) throw new CommandError(line, out, err);
        combined += out;
      }
      return combined;
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      this.channel?.end();
    } catch {
      /* ignore */
    }
    try {
      this.client?.end();
    } catch {
      /* ignore */
    }
    this.channel = undefined;
    this.client = undefined;
  }

  private handleClose(): void {
    if (!this.connected && this.client === undefined) return;
    this.connected = false;
    this.channel = undefined;
    this.client = undefined;
    for (const h of this.closeHandlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
  }

  private assertChannel(): void {
    if (!this.channel) {
      throw new Error('SSH channel is not open');
    }
  }

  private async waitForPrompt(description: string): Promise<void> {
    const deadline = Date.now() + this.commandTimeoutMs;
    while (true) {
      if (this.promptRegex.test(this.buffer)) {
        return;
      }
      if (!this.channel) {
        throw new Error(`SSH channel closed while waiting for prompt after: ${description}`);
      }
      if (Date.now() > deadline) {
        throw new SshTimeoutError(description, this.commandTimeoutMs);
      }
      await sleep(25);
    }
  }

  /** Serialise command execution across callers. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pending.then(task, task);
    this.pending = run.catch(() => undefined);
    return run;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Given the full buffer slice captured between sending `command` and matching the
 * prompt, strip: the echoed command line, trailing prompt line, and any leading
 * carriage-returns. Returns the "body" output that follows the echo.
 */
export function extractCommandOutput(
  slice: string,
  command: string,
  promptRegex: RegExp,
): string {
  // Strip the echoed command line if present. Match either exact command or
  // first `command` occurrence at the start (the device may add its own CR).
  let body = slice.replace(/^\r/, '');
  const echoIdx = body.indexOf(command);
  if (echoIdx === 0 || echoIdx === 1) {
    const nl = body.indexOf('\n', echoIdx);
    if (nl >= 0) body = body.slice(nl + 1);
  }
  // Remove trailing prompt.
  const m = promptRegex.exec(body);
  if (m && typeof m.index === 'number') {
    body = body.slice(0, m.index);
  }
  return body.replace(/\r/g, '');
}

function findError(output: string): string | undefined {
  for (const re of ERROR_PATTERNS) {
    const m = re.exec(output);
    if (m) return m[0];
  }
  return undefined;
}

function normaliseFingerprint(fp: string): string {
  return fp.replace(/^SHA256:/i, '').replace(/=+$/, '').replace(/:/g, '');
}
