import { Text2QueryServiceIfc } from "../interfaces/Text2QueryServiceIfc";
import { ReconcileServiceIfc } from "../../reconciliation/interfaces/ReconcileServiceIfc";
import { Mistral } from "@mistralai/mistralai";

import strictSchema from "../../../schemas/newSchema.strict.v2.schema.json";
import { inject, injectable } from "tsyringe";
import { MistralText2QueryServiceConfig } from "../../../config/ProjectConfig";
@injectable({ token: "MistralText2QueryService" })
// this indicates it is the default implementation for this service
@injectable({ token: "default:text2query" })
export class MistralText2QueryService implements Text2QueryServiceIfc {
  private mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });
  private reconciliation: ReconcileServiceIfc;
  private config: MistralText2QueryServiceConfig;
  constructor(
    @inject("reconciliation") reconciliationServiceIfc?: ReconcileServiceIfc,
    @inject("text2query.config")
    text2queryConfig?: MistralText2QueryServiceConfig,
  ) {
    this.reconciliation = reconciliationServiceIfc!;
    this.config = text2queryConfig!;
  }
  async generateJson(
    naturalLanguageQuery: string,
    skipReconciliation: boolean = false,
  ): Promise<JSON> {
    //Promise<z.infer<typeof SparnaturalQuery>>
    const agentId = this.config.agentId;
    console.log("Agent ID Text2Query:", agentId);
    // Appel Mistral
    const result = await this.mistral.agents.complete({
      agentId,
      messages: [
        {
          role: "user",
          content: naturalLanguageQuery,
        },
      ],
      responseFormat: {
        type: "json_schema",
        jsonSchema: {
          name: "SparnaturalQuery",
          schemaDefinition: strictSchema,
          strict: false,
        },
      },
    });
    /*
    responseFormat: {
        type: "json_schema",
        jsonSchema: {
          name: "SparnaturalQuery",
          schemaDefinition: newSchema,
          strict: true,
        },
      },
            responseFormat: {
        type: "json_object",
      },

      responseFormat: {
        type: "json_schema",
        jsonSchema: {
          name: "SparnaturalQuery",
          schemaDefinition: strictSchema,
          strict: true,
        },
      }
    */
    // Extraction contenu
    function normalizeContent(content: any): string {
      if (!content) return "";
      if (typeof content === "string") return content;
      if (Array.isArray(content))
        return content.map((c) => c.text ?? c.output_text ?? "").join("");
      return "";
    }
    console.log(
      "[text2query] Raw response from Mistral:",
      result.choices?.[0]?.message?.content,
    );
    const raw = normalizeContent(result.choices?.[0]?.message?.content);
    console.log("[text2query] Parsed JSON from Mistral:", raw);
    console.log("[text2query] Length:", raw.length);
    console.log("[text2query] Last 100 chars:", raw.slice(-100));
    console.log(
      "[text2query] Finish reason:",
      result.choices?.[0]?.finishReason,
    ); /**/
    if (!raw || raw.trim() === "") {
      throw new Error("Réponse vide de l'agent IA");
    }
    // JSON propre
    const parsed = JSON.parse(raw);

    // Reconcile URI_NOT_FOUND labels via the reconciliation service
    // Skip si demandé (pour les tests de structure)
    if (!skipReconciliation) {
      await this.reconciliation.resolveQueryUris(parsed);
    } else {
      console.log("[text2query] ⏭️  Reconciliation skipped (reconcile=false)");
    }

    return parsed;
  }
}
