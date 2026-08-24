import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../engine.js";
import { devicesRouter } from "./routes/devices.js";
import { matchRouter } from "./routes/match.js";
import { powerupsRouter } from "./routes/powerups.js";
import { pairingRouter } from "./routes/pairing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "..", "public");

export function createHttpServer(engine: Engine): http.Server {
  const app = express();
  app.use(express.json());
  app.use(express.static(publicDir));

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "running",
      serverTime: Date.now(),
      totalDevices: engine.registry.list().length,
      onlineDevices: engine.registry.list().filter((d) => d.isOnline).length,
      websocketClients: engine.ws?.clientCount() ?? 0,
      spotifyConfigured: engine.spotify.isConfigured,
    });
  });

  app.use("/api/devices", devicesRouter(engine));
  app.use("/api/pairing", pairingRouter(engine));
  app.use("/api/match", matchRouter(engine));
  app.use("/api/powerups", powerupsRouter(engine));

  app.get("/auth/spotify/login", (_req, res) => {
    const url = engine.spotify.getAuthUrl();
    if (!url) return res.status(400).send("Spotify is not configured (set SPOTIFY_CLIENT_ID/SECRET in .env)");
    res.redirect(url);
  });

  app.get("/auth/spotify/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    if (!code) return res.status(400).send("Missing code");
    const ok = await engine.spotify.handleCallback(code);
    res.send(ok ? "Spotify connected — you can close this tab." : "Spotify auth failed.");
  });

  return http.createServer(app);
}
