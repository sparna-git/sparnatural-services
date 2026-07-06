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

      // Stream the JSON to disk instead of building one giant string in memory.
      // With ~167k entities, JSON.stringify of the whole {index, uriToData}
      // object peaked past the heap limit and crashed the server at save time.
      // Here uriToData is serialized entity by entity, so the full JSON string
      // never exists in RAM at once. The on-disk format is unchanged.
      const stream = fs.createWriteStream(this.filePath, { encoding: "utf-8" });
      const write = (chunk: string): Promise<void> =>
        new Promise((resolve, reject) => {
          stream.write(chunk, (err) =>
            err ? reject(err) : resolve(),
          );
        });

      await write(`{"index":${JSON.stringify(index.toJSON())},"uriToData":{`);
      let first = true;
      for (const [uri, data] of uriToData) {
        await write(
          `${first ? "" : ","}${JSON.stringify(uri)}:${JSON.stringify(data)}`,
        );
        first = false;
      }
      await write("}}");

      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      logger.info({}, `[lunr-recon] Index saved → "${this.filePath}"`);
    } catch {
      logger.warn({}, "[lunr-recon] Failed to save index.");
    }
  }
}
