import express from "express";
import logger from "../utils/logger";
import { AppConfig } from "../config/AppConfig";

const router = express.Router({ mergeParams: true });

router.get("/", async (req: express.Request<{ projectKey: string }>, res) => {
  const { projectKey } = req.params;
  const { query, lang } = req.query;

  AppConfig.getInstance().getAppLogger().getLogger("query2text").info(
    {
      endpoint: "query2text",
      method: req.method,
      projectKey,
      query,
      headers: req.headers,
    },
    "API call started: query2text",
  );

  logger.info(
    {
      endpoint: "query2text",
      method: req.method,
      projectKey,
      query,
      headers: req.headers,
    },
    "API call started: query2text",
  );

  let summary = "Résumé simulé pour développement.";
  try {
    const jsonQuery = JSON.parse(query as string);

    const project = AppConfig.getInstance().getProject(projectKey);
    const service = project.query2textService;
    summary = await service.generateSummary(jsonQuery, lang as string);
    logger.info({ projectKey, query, summary }, "SPARQL converted to text");
  } catch (e) {
    summary = "Erreur de parsing ou d’appel à l’agent.";
  }

  return res.json({
    text: summary,
  });
});

export default router;
