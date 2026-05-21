// This endpoint generates automatically the text2query prompt for a given project.
// The SHACL file path is read from the project config (config.yaml) using the projectKey.
import express from "express";
import { T2QPromptGenerator } from "../services/prompts/impl/T2QPromptGeneratorService";
import { AppConfig } from "../config/AppConfig";

const router = express.Router({ mergeParams: true });

// GET /api/v1/:projectKey/prompt-t2q
router.get("/", async (req: express.Request<{ projectKey: string }>, res) => {
  const { projectKey } = req.params;
  try {
    const project = AppConfig.getInstance().getProject(projectKey);
    const service = project.promptGeneratorT2QService as T2QPromptGenerator;
    const lang =
      typeof req.query.lang === "string" ? req.query.lang : undefined;

    const prompt = await service.generatePromptT2Q(projectKey, lang);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(prompt);
  } catch (error: any) {
    console.error("Error generating prompt:", error);
    if (
      error.message?.includes("Unknown project") ||
      error.message?.includes("No SHACL file configured")
    ) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: "Error generating prompt" });
  }
});

export default router;
