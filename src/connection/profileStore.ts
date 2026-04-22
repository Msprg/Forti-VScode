import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Profile shape as stored in `settings.json`. Secrets live in `SecretStorage`. */
export interface StoredProfile {
  id: string;
  name?: string;
  host: string;
  port?: number;
  username: string;
  authMethod?: 'password' | 'key';
  /** Optional path to a private key on disk. The key itself may instead live in SecretStorage. */
  privateKeyPath?: string;
  hostKeyFingerprint?: string;
}

/** Profile with resolved secrets attached, ready to connect with. */
export interface ResolvedProfile extends StoredProfile {
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
}

const SECRET_PREFIX = 'fortigate.secret:';

function secretKey(profileId: string, kind: 'password' | 'privateKey' | 'passphrase'): string {
  return `${SECRET_PREFIX}${profileId}:${kind}`;
}

/**
 * Reads/writes connection profiles in `workspace.configuration.fortigate.profiles`
 * while delegating all credential material to `context.secrets` (VS Code SecretStorage).
 */
export class ProfileStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  list(): StoredProfile[] {
    const cfg = vscode.workspace.getConfiguration('fortigate');
    const profiles = cfg.get<StoredProfile[]>('profiles') ?? [];
    return profiles.map((p) => ({ ...p }));
  }

  get(id: string): StoredProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  async upsert(profile: StoredProfile): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('fortigate');
    const current = this.list();
    const idx = current.findIndex((p) => p.id === profile.id);
    if (idx >= 0) current[idx] = profile;
    else current.push(profile);
    await cfg.update('profiles', current, vscode.ConfigurationTarget.Global);
  }

  async remove(id: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('fortigate');
    const current = this.list().filter((p) => p.id !== id);
    await cfg.update('profiles', current, vscode.ConfigurationTarget.Global);
    await this.ctx.secrets.delete(secretKey(id, 'password'));
    await this.ctx.secrets.delete(secretKey(id, 'privateKey'));
    await this.ctx.secrets.delete(secretKey(id, 'passphrase'));
  }

  async setPassword(id: string, password: string | undefined): Promise<void> {
    if (password === undefined || password === '') {
      await this.ctx.secrets.delete(secretKey(id, 'password'));
    } else {
      await this.ctx.secrets.store(secretKey(id, 'password'), password);
    }
  }

  async setPrivateKey(id: string, key: string | undefined): Promise<void> {
    if (key === undefined || key === '') {
      await this.ctx.secrets.delete(secretKey(id, 'privateKey'));
    } else {
      await this.ctx.secrets.store(secretKey(id, 'privateKey'), key);
    }
  }

  async setPassphrase(id: string, passphrase: string | undefined): Promise<void> {
    if (passphrase === undefined || passphrase === '') {
      await this.ctx.secrets.delete(secretKey(id, 'passphrase'));
    } else {
      await this.ctx.secrets.store(secretKey(id, 'passphrase'), passphrase);
    }
  }

  /**
   * Combine stored profile with secrets. Reads the key from disk if `privateKeyPath`
   * is set and no secret-stored key exists.
   */
  async resolve(id: string): Promise<ResolvedProfile> {
    const p = this.get(id);
    if (!p) throw new Error(`Profile not found: ${id}`);

    const resolved: ResolvedProfile = { ...p };
    const method = p.authMethod ?? 'password';
    if (method === 'password') {
      resolved.password = await this.ctx.secrets.get(secretKey(id, 'password'));
      if (resolved.password === undefined) {
        throw new Error(`No password stored for profile '${p.id}'. Run "FortiGate: Edit Profile".`);
      }
    } else {
      const secretKeyText = await this.ctx.secrets.get(secretKey(id, 'privateKey'));
      if (secretKeyText !== undefined) {
        resolved.privateKey = Buffer.from(secretKeyText, 'utf8');
      } else if (p.privateKeyPath) {
        resolved.privateKey = await readKey(p.privateKeyPath);
      } else {
        throw new Error(
          `No private key for profile '${p.id}'. Store one via "FortiGate: Edit Profile" or set privateKeyPath.`,
        );
      }
      resolved.passphrase = await this.ctx.secrets.get(secretKey(id, 'passphrase'));
    }
    return resolved;
  }
}

async function readKey(keyPath: string): Promise<Buffer> {
  const expanded = keyPath.startsWith('~')
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', keyPath.slice(1))
    : keyPath;
  return fs.promises.readFile(expanded);
}
