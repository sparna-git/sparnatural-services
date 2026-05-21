import fs from "fs";
import path from "path";
import lunr from "lunr";
import { UriData } from "./types";
import logger from "../../../../utils/logger";

export class LunrIndexStore {
  constructor(private readonly filePath: string) {}

  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<{
    index: lunr.Index;
    uriToData: Map<string, UriData>;
  } | null> {
    try {
      logger.info({}, `[lunr-recon] Loading index from "${this.filePath}"…`);
      const raw = JSON.parse(
        await fs.promises.readFile(this.filePath, "utf-8"),
      );
      const index = lunr.Index.load(raw.index);
      const uriToData = new Map<string, UriData>();

      if (raw.uriToData) {
        for (const [uri, data] of Object.entries(
          raw.uriToData as Record<string, UriData & { altLabels?: string[] }>,
        )) {
          const fields: Record<string, string[]> = data.fields ?? {};
          // Convert old { altLabels: string[] } format to fields.altLabel
          if (
            Array.isArray(data.altLabels) &&
            data.altLabels.length > 0 &&
            !fields.altLabel
          ) {
            fields.altLabel = data.altLabels;
          }
          uriToData.set(uri, {
            label: data.label ?? uri,
            fields,
            types: data.types,
          });
        }
      } else if (raw.uriToLabel) {
        // Oldest cache format
        for (const [uri, label] of Object.entries(
          raw.uriToLabel as Record<string, string>,
        )) {
          uriToData.set(uri, { label, fields: {} });
        }
      }

      logger.info(
        {},
        `[lunr-recon] Index loaded: ${uriToData.size} entity(ies).`,
      );
      return { index, uriToData };
    } catch {
      logger.warn(
        {},
        "[lunr-recon] Failed to load cache file — rebuilding from SPARQL.",
      );
      return null;
    }
  }

  async save(
    index: lunr.Index,
    uriToData: Map<string, UriData>,
  ): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(
        this.filePath,
        JSON.stringify({
          index: index.toJSON(),
          uriToData: Object.fromEntries(uriToData),
        }),
        "utf-8",
      );
      logger.info({}, `[lunr-recon] Index saved → "${this.filePath}"`);
    } catch {
      logger.warn({}, "[lunr-recon] Failed to save index.");
    }
  }
}
