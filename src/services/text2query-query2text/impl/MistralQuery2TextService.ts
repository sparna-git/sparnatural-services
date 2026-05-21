import { Mistral } from "@mistralai/mistralai";
import { Query2TextServiceIfc } from "../interfaces/Query2TextServiceIfc";
import { inject, injectable } from "tsyringe";
import { MistralQuery2TextServiceConfig } from "../../../config/ProjectConfig";

@injectable({ token: "MistralQuery2TextService" })
// this indicates it is the default implementation for this service
@injectable({ token: "default:query2text" })
export class MistralQuery2TextService implements Query2TextServiceIfc {
  private mistral = new Mistral({
    apiKey: process.env.MISTRAL_API_KEY!,
  });

  private config: MistralQuery2TextServiceConfig;

  constructor(
    @inject("query2text.config")
    query2textConfig?: MistralQuery2TextServiceConfig,
  ) {
    this.config = query2textConfig!;
  }

  async generateSummary(jsonQuery: object, lang: string): Promise<string> {
    const agentId = this.config.agentId;
    console.log("Agent ID Query2Text:", agentId);

    const result = await this.mistral.agents.complete({
      agentId,
      messages: [
        {
          role: "user",
          content:
            `LANGUAGE=${lang}\n` +
            "SUMMARIZE THIS SPARNATURAL QUERY:\n\n" +
            JSON.stringify(jsonQuery, null, 2),
        },
      ],
      responseFormat: { type: "text" },
    });

    const content = result.choices?.[0]?.message?.content;
    console.log("Mistral response content:", content);
    if (typeof content === "string") {
      return content;
    } else if (Array.isArray(content)) {
      return content
        .filter((chunk) => chunk.type === "text")
        .map((chunk) => (chunk as any).text || "")
        .join("");
    }
    return "Réponse vide.";
  }
}
