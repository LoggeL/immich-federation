import { loadConfig } from './config.ts';
import { logger, setLogLevel } from './log.ts';
import { createGateway } from './server.ts';

const log = logger('main');
let config: ReturnType<typeof loadConfig>;
let gateway: Awaited<ReturnType<typeof createGateway>>;
try {
  config = loadConfig();
  setLogLevel(config.logLevel);
  gateway = await createGateway(config);
} catch (error) {
  log.error(`Startup failed: ${(error as Error).message}`);
  process.exit(1);
}
const port = await gateway.listen();
log.info(
  `immich-federation gateway on :${port} -> ${config.immichUrl.origin} (data: ${config.dataDir}, private remotes: ${config.allowPrivateRemotes})`,
);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    log.info(`${signal} received, shutting down …`);
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    gateway.close().finally(() => process.exit(0));
  });
}
