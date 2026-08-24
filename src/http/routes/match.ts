import { Router } from "express";
import { z } from "zod";
import type { Engine } from "../../engine.js";

const startSchema = z.object({
  playerRedName: z.string().max(32).optional(),
  playerBlueName: z.string().max(32).optional(),
});
const goalSchema = z.object({ team: z.enum(["red", "blue"]) });
const timeSchema = z.object({ deltaMs: z.number().int() });

export function matchRouter(engine: Engine): Router {
  const router = Router();

  router.get("/state", (_req, res) => {
    res.json({ devices: engine.registry.list(), match: engine.match.get() });
  });

  router.get("/history", (_req, res) => {
    res.json({ entries: engine.match.getHistory() });
  });

  router.post("/start", (req, res) => {
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ success: false, error: "invalid body" });
    engine.match.start(parsed.data.playerRedName, parsed.data.playerBlueName);
    engine.announceMatchStart();
    res.json({ success: true, match: engine.match.get() });
  });

  router.post("/pause", (_req, res) => {
    engine.match.pause();
    res.json({ success: true, match: engine.match.get() });
  });

  router.post("/resume", (_req, res) => {
    engine.match.resume();
    res.json({ success: true, match: engine.match.get() });
  });

  router.post("/reset", (_req, res) => {
    engine.match.reset();
    res.json({ success: true, match: engine.match.get() });
  });

  router.post("/time", (req, res) => {
    const parsed = timeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "deltaMs (ms, int) required" });
    engine.match.adjustTime(parsed.data.deltaMs);
    res.json({ success: true, match: engine.match.get() });
  });

  router.post("/goal", (req, res) => {
    const parsed = goalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "team must be red|blue" });
    engine.match.goal(parsed.data.team);
    res.json({ success: true, match: engine.match.get() });
  });

  router.post("/undo", (_req, res) => {
    const ok = engine.match.undoLastGoal();
    res.json({ success: ok, match: engine.match.get() });
  });

  return router;
}
