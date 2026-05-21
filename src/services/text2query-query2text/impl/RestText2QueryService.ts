import axios from "axios";
import { SparnaturalQuery } from "../../../zod/query";
import { z } from "zod";
import { EmptyRequestError } from "../../../errors/emptyRequestError";
import { ReconcileServiceIfc } from "../../reconciliation/interfaces/ReconcileServiceIfc";
import { Text2QueryServiceIfc } from "../interfaces/Text2QueryServiceIfc";
import { inject, injectable } from "tsyringe";
import { RestText2QueryServiceConfig } from "../../../config/ProjectConfig";

@injectable({ token: "RestText2QueryService" })
export class RestText2QueryService implements Text2QueryServiceIfc {
  private reconciliation: ReconcileServiceIfc;
  private config: RestText2QueryServiceConfig;

  constructor(
    @inject("reconciliation") reconcileServiceIfc?: ReconcileServiceIfc,
    @inject("text2query.config") text2queryConfig?: RestText2QueryServiceConfig,
  ) {
    this.reconciliation = reconcileServiceIfc!;
    this.config = text2queryConfig!;
  }

  async generateJson(naturalLanguageQuery: string): Promise<JSON> {
    const agentIdTextToQuery = this.config.agentId;

    const userMessage = { role: "user", content: naturalLanguageQuery };

    function extractJsonFromMarkdown(text: string): string {
      return text.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    }

    try {
      // 1. Appel à l'agent IA (sans tools)
      const response = await axios.post(
        "https://api.mistral.ai/v1/agents/completions",
        {
          agent_id: agentIdTextToQuery,
          messages: [userMessage],
          response_format: { type: "text" },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
            "Content-Type": "application/json",
          },
        },
      );

      const raw = response.data.choices?.[0]?.message?.content;
      if (!raw || raw.trim() === "") {
        throw new Error("Réponse vide de l'agent IA");
      }

      const rawClean = extractJsonFromMarkdown(raw);
      const parsed = JSON.parse(rawClean);

      // Reconcile URI_NOT_FOUND labels via the reconciliation service
      await this.reconciliation.resolveQueryUris(parsed);

      // Valider et retourner
      console.log("[text2query] ✅ JSON final généré :", parsed);
      //const validated = SparnaturalQuery.parse(parsed);
      return parsed;
    } catch (error: any) {
      if (error instanceof EmptyRequestError) throw error;
      console.error("[getJsonFromAgent] ❌ Erreur :", error.message || error);
      throw new Error(
        "Erreur lors de la génération ou validation du JSON : " +
          (error.message || error),
      );
    }
  }
}
