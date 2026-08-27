import { Router } from "express";

import { z } from "zod";

import type { Engine } from "../../engine.js";

const startSchema = z.object({
  playerRedName: z.string().max(32).optional(),
  playerBlueName: z.string().max(32).optional(),
});

const goalSchema = z.object({
  team: z.enum(["red", "blue"]),
});

const timeSchema = z.object({
  deltaMs: z.number().int(),
});

export function matchRouter(engine: Engine): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Match state
  // -------------------------------------------------------------------------

  router.get("/state", (_req, res) => {
    res.json({
      devices: engine.registry.list(),
      match: engine.match.get(),
    });
  });

  // -------------------------------------------------------------------------
  // Match history
  // -------------------------------------------------------------------------

  router.get("/history", (_req, res) => {
    res.json({
      entries: engine.match.getHistory(),
    });
  });

  // Delete / clear all match history
  router.delete("/history", async (_req, res) => {
    try {
      await engine.match.clearHistory();

      res.json({
        success: true,
        entries: [],
      });
    } catch (error) {
      console.error(
        "[match] failed to clear history:",
        error,
      );

      res.status(500).json({
        success: false,
        error: "failed to clear match history",
      });
    }
  });

  router.delete("/history/:matchId", async (req, res) => {
  try {
    const matchId = req.params.matchId;

    if (!matchId) {
      return res.status(400).json({
        success: false,
        error: "matchId is required",
      });
    }

    const deleted =
      await engine.match.deleteHistoryEntry(matchId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: "match history entry not found",
      });
    }

    res.json({
      success: true,
      matchId,
    });
  } catch (error) {
    console.error(
      "[match] failed to delete history entry:",
      error,
    );

    res.status(500).json({
      success: false,
      error: "failed to delete match history entry",
    });
  }
});

  // -------------------------------------------------------------------------
  // Start match
  // -------------------------------------------------------------------------

  router.post("/start", (req, res) => {
    const parsed = startSchema.safeParse(
      req.body ?? {},
    );

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "invalid body",
      });
    }

    engine.match.start(
      parsed.data.playerRedName,
      parsed.data.playerBlueName,
    );

    engine.announceMatchStart();

    res.json({
      success: true,
      match: engine.match.get(),
    });
  });

  // -------------------------------------------------------------------------
  // Pause
  // -------------------------------------------------------------------------

  router.post("/pause", (_req, res) => {
    engine.match.pause();

    res.json({
      success: true,
      match: engine.match.get(),
    });
  });

  // -------------------------------------------------------------------------
  // Resume
  // -------------------------------------------------------------------------

  router.post("/resume", (_req, res) => {
    engine.match.resume();

    res.json({
      success: true,
      match: engine.match.get(),
    });
  });

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  router.post("/reset", (_req, res) => {
    engine.match.reset();

    res.json({
      success: true,
      match: engine.match.get(),
    });
  });

  // -------------------------------------------------------------------------
  // Adjust match time
  // -------------------------------------------------------------------------

  router.post("/time", (req, res) => {
    const parsed = timeSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "deltaMs (ms, int) required",
      });
    }

    engine.match.adjustTime(
      parsed.data.deltaMs,
    );

    res.json({
      success: true,
      match: engine.match.get(),
    });
  });

  // -------------------------------------------------------------------------
  // Goal
  // -------------------------------------------------------------------------

  router.post("/goal", (req, res) => {
    const parsed = goalSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "team must be red|blue",
      });
    }

    engine.match.goal(parsed.data.team);

    res.json({
      success: true,
      match: engine.match.get(),
    });
  });

  // -------------------------------------------------------------------------
  // Undo last goal
  // -------------------------------------------------------------------------

  router.post("/undo", (_req, res) => {
    const ok = engine.match.undoLastGoal();

    res.json({
      success: ok,
      match: engine.match.get(),
    });
  });

  return router;
}