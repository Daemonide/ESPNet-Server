import "dotenv/config";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  httpPort: int("PORT", 8880),
  udpPort: int("UDP_PORT", 8888),
  espPort: int("ESP_PORT", 8889),

  kickerCooldownMs: int("KICKER_COOLDOWN_MS", 15_000),
  empDurationMs: int("EMP_DURATION_MS", 3_000),
  matchDurationMs: int("MATCH_DURATION_MS", 15 * 60_000),
  intenseThresholdMs: int("INTENSE_THRESHOLD_MS", 45_000),
  offlineThresholdMs: int("OFFLINE_THRESHOLD_MS", 6_000),
  discoveryBroadcastIntervalMs: int("DISCOVERY_BROADCAST_INTERVAL_MS", 2_000),

  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID ?? "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.SPOTIFY_REDIRECT_URI ?? "http://localhost:8880/auth/spotify/callback",
  },

  dataDir: "data",
} as const;
