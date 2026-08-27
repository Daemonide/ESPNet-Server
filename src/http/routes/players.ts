import { Router } from "express";
import { z } from "zod";

import type { Engine } from "../../engine.js";

const createPlayerSchema = z.object({
  name: z.string().min(1).max(64),
  team: z.enum(["red", "blue"]).nullable().optional(),
  controllerMac: z.string().nullable().optional(),
});

const updatePlayerSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  team: z.enum(["red", "blue"]).nullable().optional(),
  controllerMac: z.string().nullable().optional(),
  available: z.boolean().optional(),
});

export function playersRouter(engine: Engine): Router {
  const router = Router();

  // ============================================================
  // GET ALL PLAYERS
  // ============================================================

  router.get("/", (_req, res) => {
    res.json({
      players: engine.players.list(),
    });
  });

  // ============================================================
  // GET ONE PLAYER
  // ============================================================

  router.get("/:id", (req, res) => {
    const player = engine.players.get(req.params.id);

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "player not found",
      });
    }

    res.json({
      player,
    });
  });

  // ============================================================
  // ADD PLAYER
  // ============================================================

  router.post("/", (req, res) => {
    const parsed = createPlayerSchema.safeParse(
      req.body,
    );

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "invalid player data",
        details: parsed.error.flatten(),
      });
    }

    const player = engine.players.add(
      parsed.data.name,
      parsed.data.team ?? null,
      parsed.data.controllerMac ?? null,
    );

    res.status(201).json({
      success: true,
      player,
    });
  });

  // ============================================================
  // UPDATE PLAYER
  // ============================================================

  router.put("/:id", (req, res) => {
    const parsed = updatePlayerSchema.safeParse(
      req.body,
    );

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "invalid player data",
        details: parsed.error.flatten(),
      });
    }

    const player = engine.players.update(
      req.params.id,
      parsed.data,
    );

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "player not found",
      });
    }

    res.json({
      success: true,
      player,
    });
  });

  // ============================================================
  // CHANGE AVAILABILITY
  // ============================================================

  router.put("/:id/availability", (req, res) => {
    const schema = z.object({
      available: z.boolean(),
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "available must be boolean",
      });
    }

    const player = engine.players.setAvailability(
      req.params.id,
      parsed.data.available,
    );

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "player not found",
      });
    }

    res.json({
      success: true,
      player,
    });
  });

  // ============================================================
  // DELETE PLAYER
  // ============================================================

  router.delete("/:id", (req, res) => {
    const playerId = req.params.id;

    // First check that the player actually exists.
    const player = engine.players.get(playerId);

    if (!player) {
      return res.status(404).json({
        success: false,
        error: "player not found",
      });
    }

    // Remove the player from the player registry.
    const removed = engine.players.remove(playerId);

    if (!removed) {
      return res.status(500).json({
        success: false,
        error: "failed to remove player",
      });
    }

    // IMPORTANT:
    // Also remove every queued match that references
    // this player. This prevents stale queue entries
    // such as "Removed player vs Removed player".
    engine.queue.removePlayerReferences(playerId);

    console.log(
      `[players] removed player ${player.name} (${playerId}) and cleaned queue references`,
    );

    return res.status(200).json({
      success: true,
      playerId,
    });
  });

  return router;
}