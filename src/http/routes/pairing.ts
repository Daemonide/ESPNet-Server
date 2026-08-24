import { Router } from "express";
import { z } from "zod";
import type { Engine } from "../../engine.js";

const pairSchema = z.object({ controllerMac: z.string(), truckMac: z.string() });

export function pairingRouter(engine: Engine): Router {
  const router = Router();

  router.post("/", (req, res) => {
    const parsed = pairSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "controllerMac and truckMac required" });
    const ok = engine.registry.pair(parsed.data.controllerMac, parsed.data.truckMac);
    res.status(ok ? 200 : 404).json({ success: ok });
  });

  router.delete("/:mac", (req, res) => {
    const ok = engine.registry.unpair(req.params.mac);
    res.status(ok ? 200 : 404).json({ success: ok });
  });

  return router;
}
