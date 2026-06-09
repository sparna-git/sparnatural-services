import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { FewShot } from "./ProjectConfig";

const FewShotSchema = z.object({
  question: z.string().min(1),
  sparql: z.string().min(1),
});

const FewShotsFileSchema = z.array(FewShotSchema);

/**
 * Loads a curated NL question + SPARQL list from a JSON file.
 *
 * Returns `undefined` (not `[]`) when the path is unset or the file is
 * missing, so the caller can decide to skip registering the MCP tool
 * entirely for projects that don't ship samples.
 *
 * Throws if the file exists but is malformed — a misconfigured samples
 * file should fail loudly at startup rather than silently disabling
 * the tool.
 */
export async function loadFewShots(
  filePath?: string,
): Promise<FewShot[] | undefined> {
  if (!filePath) return undefined;

  const resolved = path.isAbsolute(filePath) ? filePath : path.join(filePath);

  try {
    await fs.access(resolved);
  } catch {
    console.warn("few-shots file not found:", resolved);
    return undefined;
  }

  const content = await fs.readFile(resolved, "utf8");
  const parsed = JSON.parse(content);
  return FewShotsFileSchema.parse(parsed);
}
