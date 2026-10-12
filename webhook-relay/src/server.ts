import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Worker } from "./worker.js";

const config = loadConfig();
const store = new Store(config.dbPath);
const app = buildApp(config, store, { logger: true });
const worker = new Worker(store, config, app.log);

app.log.info({ sources: Object.keys(config.sources) }, "configured sources");
await app.listen({ port: config.port, host: config.host });
worker.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, "shutting down");
    worker.stop();
    await app.close();
    store.close();
    process.exit(0);
  });
}
