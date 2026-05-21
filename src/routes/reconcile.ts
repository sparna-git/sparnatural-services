import express from "express";
import logger from "../utils/logger";

import { SparqlReconcileService } from "../services/reconciliation/impl/SparqlReconcileService";
import { AppConfig } from "../config/AppConfig";

const router = express.Router({ mergeParams: true });

// --- POST / ---
router.post("/", async (req: express.Request<{ projectKey: string }>, res) => {
  const { projectKey } = req.params;

  AppConfig.getInstance().getAppLogger().getLogger("reconcile").info(
    {
      endpoint: "reconcile",
      method: req.method,
      projectKey,
      query: req.query,
      body: req.body,
      headers: req.headers,
    },
    "API call started: reconciliation",
  );

  const project = AppConfig.getInstance().getProject(projectKey);
  const service = project.reconcileService;

  let queries;
  try {
    queries = SparqlReconcileService.parseQueries(req.body);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const includeTypes = req.query.includeTypes === "true";

  try {
    const responsePayload = await service.reconcileQueries(
      queries,
      includeTypes,
    );
    return res.json(responsePayload);
  } catch (err) {
    console.error("Reconciliation error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- GET / --- retourne le manifest
router.get("/", async (req: express.Request<{ projectKey: string }>, res) => {
  const { projectKey } = req.params;

  const project = AppConfig.getInstance().getProject(projectKey);
  const service = project.reconcileService;

  const manifest = await service.buildManifest();
  return res.json(manifest);
});

export default router;
