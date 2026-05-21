import axios from "axios";
import { Query2TextServiceIfc } from "../interfaces/Query2TextServiceIfc";
import { inject, injectable } from "tsyringe";
import { RestQuery2TextServiceConfig } from "../../../config/ProjectConfig";

@injectable({ token: "RestQuery2TextService" })
export class RestQuery2TextService implements Query2TextServiceIfc {
  private config: RestQuery2TextServiceConfig;

  constructor(
    @inject("query2text.config") query2textConfig?: RestQuery2TextServiceConfig,
  ) {
    this.config = query2textConfig!;
  }

  async generateSummary(jsonQuery: object, lang: string): Promise<string> {
    try {
      const agentIdQueryToText = this.config.agentId;

      const messageContent = `LANGUAGE: ${lang}\n\nQUERY:\n${JSON.stringify(
        jsonQuery,
        null,
        2,
      )}`;

      const response = await axios.post(
        "https://api.mistral.ai/v1/agents/completions",
        {
          agent_id: agentIdQueryToText,
          messages: [{ role: "user", content: messageContent }],
          response_format: { type: "text" },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
            "Content-Type": "application/json",
          },
        },
      );

      const result = response.data.choices?.[0]?.message?.content;
      return result || "Réponse vide du modèle Mistral.";
    } catch (error: any) {
      console.error(
        "Erreur Mistral (OldQuery2TextService.summarize) :",
        error?.response?.data || error.message,
      );
      return "Erreur lors de la génération du résumé avec Mistral.";
    }
  }
}
