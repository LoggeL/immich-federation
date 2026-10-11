import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Api } from './api.ts';
import { extractAuth } from './auth.ts';
import type { Config } from './config.ts';
import { assertWritableDir, resolveSecret, SecretBox } from './crypto.ts';
import { Store } from './db.ts';
import { ImmichClient } from './immich.ts';
import { handleIntercept, matchIntercept } from './intercept.ts';
import { logger, redactUrl } from './log.ts';
import { TempDir } from './media.ts';
import { Proxy } from './proxy.ts';
import { RemoteClient } from './remote.ts';
import { serveStatic } from './static.ts';
import { SyncEngine } from './sync.ts';

const log = logger('gateway');

export interface Gateway {
  server: http.Server;
  store: Store;
  sync: SyncEngine;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export async function createGateway(config: Config, { startSync = true } = {}): Promise<Gateway> {
  assertWritableDir(config.dataDir);
  const { secret, generated, fromFile } = resolveSecret(config.federationSecret, config.dataDir);
  if (generated) {
    log.warn(`FEDERATION_SECRET nicht gesetzt – zufälligen Schlüssel in ${config.dataDir}/secret.key erzeugt`);
  }
  if (fromFile) {
    log.warn(
      'Schlüssel liegt im selben Volume wie die verschlüsselten Zugangsdaten (secret.key). Für Produktion ' +
        'FEDERATION_SECRET per Umgebung/Docker-Secret außerhalb des Daten-Volumes setzen.',
    );
  }
  const box = new SecretBox(secret);
  const store = new Store(config.dataDir, box);
  const tmp = new TempDir(config.dataDir);
  await tmp.reset();
  const immich = new ImmichClient(config.immichUrl);
  const remote = new RemoteClient({ allowPrivate: config.allowPrivateRemotes, timeoutMs: config.remoteTimeoutMs });
  const sync = new SyncEngine({ store, immich, remote, config, tmp });
  const api = new Api({ store, immich, remote, sync });
  const proxy = new Proxy({ upstream: config.immichUrl });

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?', 1)[0];
    try {
      if (path === '/federation') {
        res.writeHead(302, { location: '/federation/' });
        res.end();
        return;
      }
      if (path.startsWith('/federation/api/') || path === '/federation/api') {
        await api.handle(req, res);
        return;
      }
      if (path.startsWith('/federation/')) {
        if (!(await serveStatic(req, res, config.publicDir))) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not found');
        }
        return;
      }

      const match = matchIntercept(req.method, req.url);
      if (match) {
        const handled = await handleIntercept(req, res, match, {
          store,
          remote,
          checkLocal: (r, checkPath) => proxy.checkStatus(r, checkPath),
          isLocallyEdited: async (r, assetId) => {
            const asset = await immich.getAsset(extractAuth(r), assetId);
            return asset?.isEdited === true;
          },
          passThrough: (r, s) => proxy.web(r, s),
          timeoutMs: config.interactiveTimeoutMs,
        });
        if (handled) {
          return;
        }
      }
      proxy.web(req, res);
    } catch (error) {
      log.error(`Fehler bei ${req.method} ${redactUrl(req.url ?? '')}`, error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Gateway-Fehler', statusCode: 500 }));
      } else {
        res.destroy();
      }
    }
  };

  const server = http.createServer({ requestTimeout: 0, headersTimeout: 60_000, keepAliveTimeout: 65_000 }, (req, res) => {
    void handler(req, res);
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?', 1)[0];
    if (path.startsWith('/federation')) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    proxy.upgrade(req, socket, head);
  });
  server.on('clientError', (error, socket) => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
    log.debug(`clientError: ${error.message}`);
  });

  if (startSync) {
    sync.start();
  }

  return {
    server,
    store,
    sync,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : config.port);
        });
      }),
    close: async () => {
      sync.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of sockets) {
          socket.destroy();
        }
      });
      proxy.close();
      store.close();
    },
  };
}
