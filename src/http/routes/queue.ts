import { Router } from "express";
import { z } from "zod";

import type { Engine } from "../../engine.js";

const addQueueSchema = z.object({
  redPlayerId: z.string().min(1),
  bluePlayerId: z.string().min(1),
});

const reassignSchema = z.object({
  side: z.enum(["red", "blue"]),
  playerId: z.string().min(1),
});

export function queueRouter(engine: Engine): Router {
  const router = Router();

  // Get queue
  router.get("/", (_req, res) => {
    res.json({
      queue: engine.queue.list(),
    });
  });

  // Add match to queue
  router.post("/", (req, res) => {
    const parsed = addQueueSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "redPlayerId and bluePlayerId are required",
      });
    }

    const redPlayer = engine.players.get(
      parsed.data.redPlayerId,
    );

    const bluePlayer = engine.players.get(
      parsed.data.bluePlayerId,
    );

    if (!redPlayer || !bluePlayer) {
      return res.status(404).json({
        success: false,
        error: "player not found",
      });
    }

    if (!redPlayer.available || !bluePlayer.available) {
      return res.status(400).json({
        success: false,
        error: "both players must be available",
      });
    }

    if (redPlayer.id === bluePlayer.id) {
      return res.status(400).json({
        success: false,
        error: "red and blue players must be different",
      });
    }

    const queuedMatch = engine.queue.add(
      redPlayer.id,
      bluePlayer.id,
    );

    res.status(201).json({
      success: true,
      match: queuedMatch,
    });
  });

  // Remove queued match
  router.delete("/:id", (req, res) => {
    const ok = engine.queue.remove(req.params.id);

    if (!ok) {
      return res.status(404).json({
        success: false,
        error: "queued match not found",
      });
    }

    res.json({
      success: true,
    });
  });

  // Reassign one side of a queued match
  router.patch("/:id", (req, res) => {
    const parsed = reassignSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "side must be red|blue and playerId is required",
      });
    }

    const player = engine.players.get(parsed.data.playerId);

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "player not found",
      });
    }

    if (!player.available) {
      return res.status(400).json({
        success: false,
        error: "player is not available",
      });
    }

    const queuedMatch = engine.queue.get(req.params.id);

    if (!queuedMatch) {
      return res.status(404).json({
        success: false,
        error: "queued match not found",
      });
    }

    const changes =
      parsed.data.side === "red"
        ? { playerRedId: parsed.data.playerId }
        : { playerBlueId: parsed.data.playerId };

    const updated = engine.queue.update(
      req.params.id,
      changes,
    );

    res.json({
      success: true,
      match: updated,
    });
  });

  // Start queued match
  router.post("/:id/start", (req, res) => {
    const queuedMatch = engine.queue.get(req.params.id);

    if (!queuedMatch) {
      return res.status(404).json({
        success: false,
        error: "queued match not found",
      });
    }

    const redPlayer = engine.players.get(
      queuedMatch.playerRedId,
    );

    const bluePlayer = engine.players.get(
      queuedMatch.playerBlueId,
    );

    if (!redPlayer || !bluePlayer) {
      return res.status(404).json({
        success: false,
        error: "queued player not found",
      });
    }

    if (!redPlayer.available || !bluePlayer.available) {
      return res.status(400).json({
        success: false,
        error: "both players must be available",
      });
    }

    // Reuse the existing match-start logic.
    engine.match.start(
      redPlayer.name,
      bluePlayer.name,
    );

    engine.announceMatchStart();

    // Remove the match from queue once it starts.
    engine.queue.remove(req.params.id);

    // Players currently playing are no longer available.
    engine.players.update(redPlayer.id, {
      available: false,
    });

    engine.players.update(bluePlayer.id, {
      available: false,
    });

    res.json({
      success: true,
      match: engine.match.get(),
    });
  });

  return router;
}