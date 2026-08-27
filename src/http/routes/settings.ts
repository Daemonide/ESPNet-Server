import { Router } from "express";
import { z } from "zod";

import type { Engine } from "../../engine.js";

const settingsSchema = z.object({
  matchDurationMin: z.number().positive(),

  intenseModeTriggerSec: z.number().nonnegative(),

  goalLimit: z.number().int().positive(),

  winCondition: z.enum([
    "Most goals when time ends",
    "First to N goals",
    "Golden goal / sudden death",
  ]),

  suddenDeathOnTie: z.boolean(),

  autoPauseOnDisconnect: z.boolean(),

  kickerCooldownSec: z.number().nonnegative(),

  empCooldownSec: z.number().nonnegative(),

  kickerEnabled: z.boolean(),

  empEnabled: z.boolean(),

  lightingMode: z.enum([
    "Match live (auto)",
    "Always on",
    "Off",
  ]),

  confettiOnGoal: z.boolean(),

  arenaShakeOnGoal: z.boolean(),

  ledSweepInIntense: z.boolean(),

  goalSound: z.boolean(),

  intenseModeMusic: z.boolean(),

  matchEndMusic: z.boolean(),

  masterVolume: z.number().min(0).max(100),
});

export function settingsRouter(
  engine: Engine,
): Router {
  const router = Router();

  // ============================================================
  // GET /api/settings
  // Get current settings
  // ============================================================

  router.get("/", (_req, res) => {
    try {
      const settings = engine.settings.get();

      return res.json({
        success: true,
        settings,
      });
    } catch (error) {
      console.error(
        "[settings] GET failed:",
        error,
      );

      return res.status(500).json({
        success: false,
        error: "failed to get settings",
      });
    }
  });

  // ============================================================
  // PUT /api/settings
  // Update settings
  // ============================================================

  router.put("/", (req, res) => {
    try {
      const parsed =
        settingsSchema.safeParse(req.body);

      if (!parsed.success) {
        console.error(
          "[settings] invalid settings:",
          parsed.error.flatten(),
        );

        return res.status(400).json({
          success: false,
          error: "invalid settings data",
          details: parsed.error.flatten(),
        });
      }

      const settings =
        engine.settings.update(parsed.data);

      console.log(
        "[settings] updated:",
        settings,
      );

      return res.json({
        success: true,
        settings,
      });
    } catch (error) {
      console.error(
        "[settings] PUT failed:",
        error,
      );

      return res.status(500).json({
        success: false,
        error: "failed to update settings",
      });
    }
  });

  return router;
}