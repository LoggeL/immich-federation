import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = 'v1';

/** AES-256-GCM box. Ciphertext format: `v1:<base64(iv[12] | tag[16] | ciphertext)>` */
export class SecretBox {
  #key: Buffer;

  constructor(secret: string | Buffer) {
    if (!secret || secret.length < 16) {
      throw new Error('FEDERATION_SECRET must be at least 16 characters long');
    }
    this.#key = Buffer.from(hkdfSync('sha256', secret, 'immich-federation', 'storage-key-v1', 32));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  decrypt(value: string): string {
    const [version, payload] = value.split(':', 2);
    if (version !== VERSION || !payload) {
      throw new Error('Unsupported ciphertext format');
    }
    const raw = Buffer.from(payload, 'base64');
    if (raw.length < 28) {
      throw new Error('Ciphertext too short');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/**
 * Use FEDERATION_SECRET if given; otherwise generate one once and keep it in DATA_DIR/secret.key
 * so a plain `docker compose up` works without extra configuration.
 */
export function resolveSecret(
  configured: string | undefined,
  dataDir: string,
): { secret: string; generated: boolean; fromFile: boolean } {
  if (configured) {
    return { secret: configured, generated: false, fromFile: false };
  }
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) {
    return { secret: readFileSync(file, 'utf8').trim(), generated: false, fromFile: true };
  }
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret + '\n', { mode: 0o600 });
  return { secret, generated: true, fromFile: true };
}

/** Clear error instead of an EACCES stack trace when the data directory is not writable. */
export function assertWritableDir(dir: string) {
  try {
    accessSync(dir, constants.W_OK | constants.R_OK);
  } catch {
    const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
    throw new Error(
      `DATA_DIR ${dir} ist nicht beschreibbar für UID ${uid} – auf dem Host z.B. "chown -R 1000:1000 <host-pfad>" ausführen ` +
        'oder ein benanntes Docker-Volume verwenden',
    );
  }
}
