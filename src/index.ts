import { config } from "./config.js";
import { Engine } from "./engine.js";
import { createHttpServer } from "./http/server.js";

async function main(): Promise<void> {
  const engine = new Engine();
  const httpServer = createHttpServer(engine);

  await engine.init(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(config.httpPort, () => resolve());
  });
  console.log(`[http] listening on http://localhost:${config.httpPort}`);
  console.log("RoboSoccer server ready.");

  const shutdown = async (signal: string) => {
    console.log(`\n[server] received ${signal}, shutting down...`);
    await engine.shutdown();
    httpServer.close(() => process.exit(0));
    // Force-exit if something keeps the event loop alive.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
