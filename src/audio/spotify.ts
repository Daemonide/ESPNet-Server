import path from "node:path";
import { config } from "../config.js";
import { JsonStore } from "../persistence/store.js";

interface SpotifyTokens {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const SCOPES = ["streaming", "user-read-playback-state", "user-modify-playback-state"].join(" ");

/**
 * Thin wrapper around Spotify's Authorization Code flow + Web API playback
 * control. Every public method degrades to a safe no-op when no client
 * credentials are configured (`.env` left blank) — the arena's audio still
 * runs on the dashboard's client-side Web Audio synth either way, so Spotify
 * is a bonus layer, never a dependency.
 */
export class SpotifyClient {
  private tokens: SpotifyTokens = { accessToken: null, refreshToken: null, expiresAt: null };
  private store: JsonStore<SpotifyTokens>;

  constructor() {
    this.store = new JsonStore<SpotifyTokens>(path.join(config.dataDir, "spotify.json"), {
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    });
  }

  get isConfigured(): boolean {
    return Boolean(config.spotify.clientId && config.spotify.clientSecret);
  }

  async init(): Promise<void> {
    if (!this.isConfigured) return;
    this.tokens = await this.store.load();
  }

  getAuthUrl(): string | null {
    if (!this.isConfigured) return null;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.spotify.clientId,
      scope: SCOPES,
      redirect_uri: config.spotify.redirectUri,
    });
    return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
  }

  async handleCallback(code: string): Promise<boolean> {
    if (!this.isConfigured) return false;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.spotify.redirectUri,
    });
    return this.requestToken(body);
  }

  private async refresh(): Promise<boolean> {
    if (!this.isConfigured || !this.tokens.refreshToken) return false;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
    });
    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<boolean> {
    try {
      const auth = Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString(
        "base64",
      );
      const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (!res.ok) return false;
      const data = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      this.tokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? this.tokens.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000 - 30_000,
      };
      this.store.save(this.tokens);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureFreshToken(): Promise<string | null> {
    if (!this.isConfigured) return null;
    if (this.tokens.accessToken && this.tokens.expiresAt && Date.now() < this.tokens.expiresAt) {
      return this.tokens.accessToken;
    }
    const refreshed = await this.refresh();
    return refreshed ? this.tokens.accessToken : null;
  }

  private async call(endpoint: string, init: RequestInit): Promise<void> {
    const token = await this.ensureFreshToken();
    if (!token) return; // silently skip — no active session / not configured
    try {
      await fetch(`${SPOTIFY_API_BASE}${endpoint}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      });
    } catch {
      // Best-effort ambiance layer — a failed Spotify call must never take
      // down a live match. Errors are swallowed here by design.
    }
  }

  async duck(): Promise<void> {
    await this.call("/me/player/volume?volume_percent=20", { method: "PUT" });
  }

  async resume(): Promise<void> {
    await this.call("/me/player/volume?volume_percent=80", { method: "PUT" });
    await this.call("/me/player/play", { method: "PUT" });
  }

  async pause(): Promise<void> {
    await this.call("/me/player/pause", { method: "PUT" });
  }

  async playPlaylist(playlistUri: string): Promise<void> {
    await this.call("/me/player/play", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context_uri: playlistUri }),
    });
  }
}
