import { Router } from "express";
import { z } from "zod";
import type { Engine } from "../../engine.js";

// These mirror the UDP EVENT|KICK_REQ / EVENT|EMP_REQ paths so the dashboard
// can trigger the exact same validated engine logic — useful for refereeing
// without hardware, and for demoing/testing the power-up rules directly.
const kickSchema = z.object({ mac: z.string() });
const empSchema = z.object({ mac: z.string(), targetTeam: z.enum(["red", "blue"]) });

export function powerupsRouter(engine: Engine): Router {
  const router = Router();

  router.post("/kick", (req, res) => {
    const parsed = kickSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "mac required" });
    engine.handleKickRequest(parsed.data.mac);
    res.json({ success: true });
  });

  router.post("/emp", (req, res) => {
    const parsed = empSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "mac and targetTeam required" });
    engine.handleEmpRequest(parsed.data.mac, parsed.data.targetTeam);
    res.json({ success: true });
  });

  return router;
}
