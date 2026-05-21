/**
 * This file is responsible for generating the prompt for the query2text agent.
 * It takes a projectKey, reads the SHACL model,
 * and returns a complete prompt to use in the query2text agent.
 *
 * The prompt is composed of two parts:
 *  1. A STATIC part
 *  2. A DYNAMIC part (Class and Property Label Reference)
 */

import { inject, injectable } from "tsyringe";
import { Q2TPromptGeneratorIfc } from "../interfaces/Q2TPromptGeneratorIfc";
import { PromptGeneratorQ2TConfig } from "../../../config/ProjectConfig";
import {
  Q2T_STATIC_PART_BEFORE,
  Q2T_STATIC_PART_AFTER,
} from "../helpers/Q2TPromptParts";
import { getSHACLConfig } from "../../../config/SCHACL";

import {
  PropertyShape,
  SparnaturalNodeShape,
  SparnaturalPropertyShape,
  SparnaturalShaclModel,
  ShaclModel,
} from "rdf-shacl-commons";

import { loadAdditionalInstructions } from "../../../config/AdditionalInstructions";

@injectable({ token: "Q2TPromptGenerator" })
@injectable({ token: "default:q2tPromptGenerator" })
export class Q2TPromptGenerator implements Q2TPromptGeneratorIfc {
  private config: PromptGeneratorQ2TConfig;

  constructor(
    @inject("q2tPromptGenerator.config") config: PromptGeneratorQ2TConfig,
  ) {
    this.config = config;
  }

  async generatePromptQ2T(
    projectKey: string,
    language?: string,
  ): Promise<string> {
    const lang = language ?? this.config.language ?? "en";
    const { model } = await getSHACLConfig(projectKey);
    const sparnaturalModel = new SparnaturalShaclModel(model);
    const additionalInstructions = await loadAdditionalInstructions(
      this.config.additionalInstructions,
    );
    const referenceTable = this.buildReferenceTable(
      sparnaturalModel,
      model,
      lang,
    );
    let prompt: string;

    return (prompt =
      Q2T_STATIC_PART_BEFORE +
      additionalInstructions +
      referenceTable +
      Q2T_STATIC_PART_AFTER);
  }

  private buildReferenceTable(
    sparnaturalModel: SparnaturalShaclModel,
    shaclModel: ShaclModel,
    language: string,
  ): string {
    const allNodeShapes = shaclModel
      .readAllNodeShapes()
      .map((ns) => new SparnaturalNodeShape(ns));

    const langHeader = `${language} label`;

    let result = "\nClass and Property Label Reference:\n\n";
    result +=
      "Use ONLY these labels in the generated sentence. Never use raw URIs or variable names.\n\n";

    // --- Classes ---
    result += `Classes (rdfType URI -> ${langHeader}):\n\n`;
    allNodeShapes.forEach((sns) => {
      const id = sns.getId();
      const labels = sns.getNodeShape().getLabel(language) ?? id;
      const tooltip =
        sns.getNodeShape().getTooltip(language) ?? "No description available.";
      result += `  ${id} -> ${labels} — ${tooltip}\n`;
    });

    // --- Properties ---
    result += `\nProperties (predicate URI -> ${langHeader}):\n\n`;
    allNodeShapes.forEach((sns) => {
      const validProps: PropertyShape[] = sns.getValidProperties();
      validProps.forEach((propShape) => {
        const propUri = propShape.resource.value;
        const labels = propShape.getLabel(language) ?? "unknown";
        const tooltip =
          propShape.getTooltip(language) ?? "No description available.";
        result += `  ${propUri} -> ${labels} — ${tooltip}\n`;
      });
    });

    return result;
  }
}
