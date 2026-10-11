import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { SecretBox } from './crypto.ts';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  apiKeyId: string;
  apiKey: string; // decrypted
}

export interface LinkRow {
  id: string;
  userId: string;
  baseUrl: string;
  serverHost: string;
  shareKey: string | null; // decrypted
  shareSlug: string | null; // decrypted
  remoteLinkId: string;
  remoteAlbumId: string | null;
  remoteAlbumName: string;
  remoteOwnerName: string;
  albumId: string;
  showInTimeline: boolean;
  allowDownload: boolean;
  showMetadata: boolean;
  /** false = videos of this link are not imported (no full video download/transcode) */
  importVideos: boolean;
  createdAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface AssetRow {
  linkId: string;
  remoteAssetId: string;
  localAssetId: string;
  type: string;
  originalFileName: string | null;
  originalMimeType: string | null;
  /** 1 = the gateway created this local asset (may be intercepted/deleted). 0 = adopted duplicate of a foreign asset. */
  owned: boolean;
  /** 1 = user deleted it locally, do not re-add. */
  dismissed: boolean;
  /** date/GPS/description PUT succeeded (retried on later syncs otherwise) */
  metaApplied: boolean;
  syncedAt: string;
}

export interface FederatedAssetInfo extends AssetRow {
  baseUrl: string;
  serverHost: string;
  shareKey: string | null;
  shareSlug: string | null;
  remoteOwnerName: string;
  allowDownload: boolean;
  userId: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  apiKeyId TEXT NOT NULL,
  apiKeyEnc TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id),
  baseUrl TEXT NOT NULL,
  serverHost TEXT NOT NULL,
  shareKeyEnc TEXT,
  shareSlugEnc TEXT,
  remoteLinkId TEXT NOT NULL,
  remoteAlbumId TEXT,
  remoteAlbumName TEXT NOT NULL,
  remoteOwnerName TEXT NOT NULL,
  albumId TEXT NOT NULL,
  showInTimeline INTEGER NOT NULL DEFAULT 1,
  allowDownload INTEGER NOT NULL DEFAULT 1,
  showMetadata INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  lastSyncedAt TEXT,
  lastError TEXT
);
CREATE INDEX IF NOT EXISTS links_user ON links(userId);
CREATE INDEX IF NOT EXISTS links_album ON links(albumId);
CREATE TABLE IF NOT EXISTS assets (
  linkId TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  remoteAssetId TEXT NOT NULL,
  localAssetId TEXT NOT NULL,
  type TEXT NOT NULL,
  originalFileName TEXT,
  originalMimeType TEXT,
  owned INTEGER NOT NULL DEFAULT 1,
  dismissed INTEGER NOT NULL DEFAULT 0,
  syncedAt TEXT NOT NULL,
  PRIMARY KEY (linkId, remoteAssetId)
);
CREATE INDEX IF NOT EXISTS assets_local ON assets(localAssetId);
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  linkId TEXT NOT NULL,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_log_link ON sync_log(linkId, id);
`;

const b = (v: unknown) => v === 1 || v === true || v === 1n;

export class Store {
  db: DatabaseSync;
  #box: SecretBox;

  constructor(dataDir: string, box: SecretBox, filename = 'federation.sqlite') {
    this.db = new DatabaseSync(filename === ':memory:' ? ':memory:' : join(dataDir, filename));
    this.#box = box;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  #migrate() {
    const has = (table: string, column: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
    if (!has('links', 'importVideos')) {
      this.db.exec('ALTER TABLE links ADD COLUMN importVideos INTEGER NOT NULL DEFAULT 1');
    }
    if (!has('assets', 'metaApplied')) {
      this.db.exec('ALTER TABLE assets ADD COLUMN metaApplied INTEGER NOT NULL DEFAULT 1');
    }
  }

  close() {
    this.db.close();
  }

  // ---------- users ----------
  getUser(id: string): UserRow | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    if (!row) {
      return undefined;
    }
    return { id: row.id, email: row.email, name: row.name, apiKeyId: row.apiKeyId, apiKey: this.#box.decrypt(row.apiKeyEnc) };
  }

  upsertUser(user: UserRow) {
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, apiKeyId, apiKeyEnc, createdAt) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name,
           apiKeyId = excluded.apiKeyId, apiKeyEnc = excluded.apiKeyEnc`,
      )
      .run(user.id, user.email, user.name, user.apiKeyId, this.#box.encrypt(user.apiKey), new Date().toISOString());
  }

  // ---------- links ----------
  #mapLink(row: any): LinkRow {
    return {
      id: row.id,
      userId: row.userId,
      baseUrl: row.baseUrl,
      serverHost: row.serverHost,
      shareKey: row.shareKeyEnc ? this.#box.decrypt(row.shareKeyEnc) : null,
      shareSlug: row.shareSlugEnc ? this.#box.decrypt(row.shareSlugEnc) : null,
      remoteLinkId: row.remoteLinkId,
      remoteAlbumId: row.remoteAlbumId,
      remoteAlbumName: row.remoteAlbumName,
      remoteOwnerName: row.remoteOwnerName,
      albumId: row.albumId,
      showInTimeline: b(row.showInTimeline),
      allowDownload: b(row.allowDownload),
      showMetadata: b(row.showMetadata),
      importVideos: row.importVideos === undefined || row.importVideos === null ? true : b(row.importVideos),
      createdAt: row.createdAt,
      lastSyncedAt: row.lastSyncedAt,
      lastError: row.lastError,
    };
  }

  insertLink(link: LinkRow) {
    this.db
      .prepare(
        `INSERT INTO links (id, userId, baseUrl, serverHost, shareKeyEnc, shareSlugEnc, remoteLinkId, remoteAlbumId,
           remoteAlbumName, remoteOwnerName, albumId, showInTimeline, allowDownload, showMetadata, importVideos, createdAt, lastSyncedAt, lastError)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        link.id,
        link.userId,
        link.baseUrl,
        link.serverHost,
        link.shareKey ? this.#box.encrypt(link.shareKey) : null,
        link.shareSlug ? this.#box.encrypt(link.shareSlug) : null,
        link.remoteLinkId,
        link.remoteAlbumId,
        link.remoteAlbumName,
        link.remoteOwnerName,
        link.albumId,
        link.showInTimeline ? 1 : 0,
        link.allowDownload ? 1 : 0,
        link.showMetadata ? 1 : 0,
        link.importVideos === false ? 0 : 1,
        link.createdAt,
        link.lastSyncedAt,
        link.lastError,
      );
  }

  getLink(id: string): LinkRow | undefined {
    const row = this.db.prepare('SELECT * FROM links WHERE id = ?').get(id);
    return row ? this.#mapLink(row) : undefined;
  }

  listLinks(userId?: string): LinkRow[] {
    const rows = userId
      ? this.db.prepare('SELECT * FROM links WHERE userId = ? ORDER BY createdAt').all(userId)
      : this.db.prepare('SELECT * FROM links ORDER BY createdAt').all();
    return rows.map((r) => this.#mapLink(r));
  }

  findLinkByRemote(userId: string, baseUrl: string, remoteLinkId: string, remoteAlbumId: string | null): LinkRow | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM links WHERE userId = ? AND baseUrl = ? AND (remoteLinkId = ? OR (remoteAlbumId IS NOT NULL AND remoteAlbumId = ?))',
      )
      .get(userId, baseUrl, remoteLinkId, remoteAlbumId ?? '');
    return row ? this.#mapLink(row) : undefined;
  }

  updateLink(id: string, patch: Partial<Omit<LinkRow, 'id' | 'shareKey' | 'shareSlug'>>) {
    const columns: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      columns.push(`${key} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null));
    }
    if (columns.length === 0) {
      return;
    }
    this.db.prepare(`UPDATE links SET ${columns.join(', ')} WHERE id = ?`).run(...values, id);
  }

  deleteLink(id: string) {
    this.db.prepare('DELETE FROM assets WHERE linkId = ?').run(id);
    this.db.prepare('DELETE FROM sync_log WHERE linkId = ?').run(id);
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id);
  }

  // ---------- assets ----------
  #mapAsset(row: any): AssetRow {
    return {
      linkId: row.linkId,
      remoteAssetId: row.remoteAssetId,
      localAssetId: row.localAssetId,
      type: row.type,
      originalFileName: row.originalFileName,
      originalMimeType: row.originalMimeType,
      owned: b(row.owned),
      dismissed: b(row.dismissed),
      metaApplied: row.metaApplied === undefined || row.metaApplied === null ? true : b(row.metaApplied),
      syncedAt: row.syncedAt,
    };
  }

  listAssets(linkId: string): AssetRow[] {
    return this.db
      .prepare('SELECT * FROM assets WHERE linkId = ?')
      .all(linkId)
      .map((r) => this.#mapAsset(r));
  }

  countAssets(linkId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM assets WHERE linkId = ? AND dismissed = 0')
      .get(linkId) as { n: number };
    return Number(row.n);
  }

  upsertAsset(asset: AssetRow) {
    this.db
      .prepare(
        `INSERT INTO assets (linkId, remoteAssetId, localAssetId, type, originalFileName, originalMimeType, owned, dismissed, metaApplied, syncedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(linkId, remoteAssetId) DO UPDATE SET localAssetId = excluded.localAssetId, type = excluded.type,
           originalFileName = excluded.originalFileName, originalMimeType = excluded.originalMimeType,
           owned = excluded.owned, dismissed = excluded.dismissed, metaApplied = excluded.metaApplied, syncedAt = excluded.syncedAt`,
      )
      .run(
        asset.linkId,
        asset.remoteAssetId,
        asset.localAssetId,
        asset.type,
        asset.originalFileName,
        asset.originalMimeType,
        asset.owned ? 1 : 0,
        asset.dismissed ? 1 : 0,
        asset.metaApplied === false ? 0 : 1,
        asset.syncedAt,
      );
  }

  setDismissed(linkId: string, remoteAssetId: string, dismissed: boolean) {
    this.db
      .prepare('UPDATE assets SET dismissed = ? WHERE linkId = ? AND remoteAssetId = ?')
      .run(dismissed ? 1 : 0, linkId, remoteAssetId);
  }

  setMetaApplied(linkId: string, remoteAssetId: string, applied: boolean) {
    this.db
      .prepare('UPDATE assets SET metaApplied = ? WHERE linkId = ? AND remoteAssetId = ?')
      .run(applied ? 1 : 0, linkId, remoteAssetId);
  }

  deleteAsset(linkId: string, remoteAssetId: string) {
    this.db.prepare('DELETE FROM assets WHERE linkId = ? AND remoteAssetId = ?').run(linkId, remoteAssetId);
  }

  /** How many mappings (in any link) point to this local asset */
  countLocalReferences(localAssetId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM assets WHERE localAssetId = ?').get(localAssetId) as {
      n: number;
    };
    return Number(row.n);
  }

  isOwnedLocalAsset(localAssetId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM assets WHERE localAssetId = ? AND owned = 1 LIMIT 1').get(localAssetId);
  }

  /** Lookup for interception: the owned, federated mapping of a local asset id (first link wins). */
  getFederatedAsset(localAssetId: string): FederatedAssetInfo | undefined {
    const row = this.db
      .prepare(
        `SELECT a.*, l.baseUrl, l.serverHost, l.shareKeyEnc, l.shareSlugEnc, l.remoteOwnerName, l.allowDownload, l.userId
         FROM assets a JOIN links l ON l.id = a.linkId
         WHERE a.localAssetId = ? AND a.owned = 1 ORDER BY a.syncedAt LIMIT 1`,
      )
      .get(localAssetId) as any;
    if (!row) {
      return undefined;
    }
    return {
      ...this.#mapAsset(row),
      baseUrl: row.baseUrl,
      serverHost: row.serverHost,
      shareKey: row.shareKeyEnc ? this.#box.decrypt(row.shareKeyEnc) : null,
      shareSlug: row.shareSlugEnc ? this.#box.decrypt(row.shareSlugEnc) : null,
      remoteOwnerName: row.remoteOwnerName,
      allowDownload: b(row.allowDownload),
      userId: row.userId,
    };
  }

  // ---------- log ----------
  log(linkId: string, level: 'info' | 'warn' | 'error', message: string) {
    this.db
      .prepare('INSERT INTO sync_log (linkId, at, level, message) VALUES (?, ?, ?, ?)')
      .run(linkId, new Date().toISOString(), level, message.slice(0, 2000));
    // keep the log bounded per link
    this.db
      .prepare(
        'DELETE FROM sync_log WHERE linkId = ? AND id NOT IN (SELECT id FROM sync_log WHERE linkId = ? ORDER BY id DESC LIMIT 200)',
      )
      .run(linkId, linkId);
  }

  getLog(linkId: string, limit = 50) {
    return this.db
      .prepare('SELECT at, level, message FROM sync_log WHERE linkId = ? ORDER BY id DESC LIMIT ?')
      .all(linkId, limit) as Array<{ at: string; level: string; message: string }>;
  }
}
