import { Router } from "express";
import { z } from "zod";
import type { Engine } from "../../engine.js";

const teamSchema = z.object({ team: z.enum(["red", "blue"]).nullable() });
const nodeTypeSchema = z.object({ nodeType: z.enum(["controller", "truck", "lighting"]).nullable() });
const labelSchema = z.object({ label: z.string().max(64).nullable() });

export function devicesRouter(engine: Engine): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ devices: engine.registry.list() });
  });

  router.put("/:mac/team", (req, res) => {
    const parsed = teamSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "invalid team" });
    const ok = engine.registry.setTeam(req.params.mac, parsed.data.team);
    res.status(ok ? 200 : 404).json({ success: ok });
  });

  router.put("/:mac/node-type", (req, res) => {
    const parsed = nodeTypeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "invalid nodeType" });
    const ok = engine.registry.setNodeType(req.params.mac, parsed.data.nodeType);
    res.status(ok ? 200 : 404).json({ success: ok });
  });

  router.put("/:mac/label", (req, res) => {
    const parsed = labelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "invalid label" });
    const ok = engine.registry.setLabel(req.params.mac, parsed.data.label);
    res.status(ok ? 200 : 404).json({ success: ok });
  });

  router.delete("/:mac", (req, res) => {
    const ok = engine.registry.remove(req.params.mac);
    res.status(ok ? 200 : 404).json({ success: ok });
  });

  return router;
}
