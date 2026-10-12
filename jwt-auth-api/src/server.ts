import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig();
if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
const store = new Store(config.dbPath);
const app = await buildApp(config, store, { logger: true });

await app.listen({ port: config.port, host: config.host });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    store.close();
    process.exit(0);
  });
}
