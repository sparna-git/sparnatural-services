import { T2QPromptGeneratorIfc } from "../interfaces/T2QPromptGeneratorIfc";
import { inject, injectable } from "tsyringe";
import { PromptGeneratorT2QConfig } from "../../../config/ProjectConfig";
import {
  T2Q_STATIC_PART_BEFORE,
  T2Q_STATIC_PART_AFTER,
} from "../helpers/T2QPromptParts";
import { getSHACLConfig } from "../../../config/SCHACL";

import {
  PropertyShape,
  NodeShape,
  SparnaturalNodeShape,
  SparnaturalPropertyShape,
  SparnaturalShaclModel,
  SearchWidgetIfc,
  SPARNATURAL,
  ShaclModel,
  DagNodeIfc,
  Resource,
} from "rdf-shacl-commons";
import { loadAdditionalInstructions } from "../../../config/AdditionalInstructions";

@injectable({ token: "T2QPromptGenerator" })
@injectable({ token: "default:t2qPromptGenerator" })
export class T2QPromptGenerator implements T2QPromptGeneratorIfc {
  private config: PromptGeneratorT2QConfig;

  constructor(
    @inject("t2qPromptGenerator.config") config: PromptGeneratorT2QConfig,
  ) {
    this.config = config;
  }

  async generatePromptT2Q(projectKey: string, lang?: string): Promise<string> {
    const language = lang ?? this.config.language ?? "en";
    const { model } = await getSHACLConfig(projectKey);
    const sparnaturalModel = new SparnaturalShaclModel(model);
    const additionalInstructions = await loadAdditionalInstructions(
      this.config.additionalInstructions,
    );
    console.log(
      "Additional instructions for T2Q prompt:",
      additionalInstructions,
    );
    const referenceTable = this.buildReferenceTable(
      sparnaturalModel,
      model,
      language,
    );
    // additionalInstructions (few-shots) placed LAST so they are closest to the user query
    // and are not diluted by the reference table and rules that follow them.
    return (
      T2Q_STATIC_PART_BEFORE +
      referenceTable +
      T2Q_STATIC_PART_AFTER +
      additionalInstructions
    );
  }

  /** Strip markdown syntax from a description before injecting into the prompt.
   *  Accepts string, string[] (joined with space), or null/undefined. */
  private static stripMarkdown(
    text: string | string[] | null | undefined,
  ): string {
    const raw = Array.isArray(text) ? text.join(" ") : (text ?? "");
    return raw
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
      .replace(/`([^`]+)`/g, "$1") // `code` → code
      .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** → bold
      .replace(/\*([^*]+)\*/g, "$1") // *italic* → italic
      .trim();
  }

  /**
   * Find the longest common URI prefix (ending at the last # or /) shared by all provided URIs.
   * Returns null if no meaningful common prefix exists.
   */
  private computeShapePrefix(uris: string[]): string | null {
    if (uris.length === 0) return null;
    let prefix = uris[0];
    for (const uri of uris.slice(1)) {
      while (prefix.length > 0 && !uri.startsWith(prefix)) {
        prefix = prefix.slice(0, prefix.length - 1);
      }
    }
    const lastHash = prefix.lastIndexOf("#");
    const lastSlash = prefix.lastIndexOf("/");
    const boundary = Math.max(lastHash, lastSlash);
    if (boundary < 10) return null;
    return prefix.slice(0, boundary + 1);
  }

  private buildReferenceTable(
    sparnaturalModel: SparnaturalShaclModel,
    shaclModel: ShaclModel,
    language: string,
  ): string {
    // Step 1: Category A from the DAG (non-disabled nodes)
    const entryPoints = sparnaturalModel.getEntryPointsNodeShapes(language);
    const entryPointIds = new Set<string>();
    entryPoints.traverseBreadthFirst(
      (node: DagNodeIfc<SparnaturalNodeShape>) => {
        if (!node.disabled) {
          entryPointIds.add(node.payload.getId());
        }
      },
    );

    // Step 2: All NodeShapes → subtract Cat A → Cat B
    const allNodeShapes = shaclModel
      .readAllNodeShapes()
      .map((ns) => new SparnaturalNodeShape(ns));

    const categoryAShapes: SparnaturalNodeShape[] = [];
    entryPoints.traverseBreadthFirst(
      (node: DagNodeIfc<SparnaturalNodeShape>) => {
        if (!node.disabled) {
          categoryAShapes.push(node.payload);
        }
      },
    );

    const categoryBShapes = allNodeShapes.filter(
      (sns) => !entryPointIds.has(sns.getId()),
    );

    // Build category arrays
    // description = what the class is (shown in Category A/B listing)
    // agentInstruction = how to navigate/use it (shown in property table header)
    const categoryA = categoryAShapes.map((sns) => ({
      id: sns.getId(),
      label: sns.getNodeShape().getLabel(language) ?? sns.getId(),
      description: T2QPromptGenerator.stripMarkdown(
        sns.getNodeShape().getTooltip(language) ?? "",
      ),
      agentInstruction: T2QPromptGenerator.stripMarkdown(
        sns.getNodeShape().getShAgentInstruction(language) ?? "",
      ),
      sparnaturalNodeShape: sns,
    }));

    const categoryB = categoryBShapes.map((sns) => ({
      id: sns.getId(),
      label: sns.getNodeShape().getLabel(language) ?? sns.getId(),
      description: T2QPromptGenerator.stripMarkdown(
        sns.getNodeShape().getTooltip(language) ?? "",
      ),
      agentInstruction: T2QPromptGenerator.stripMarkdown(
        sns.getNodeShape().getShAgentInstruction(language) ?? "",
      ),
      sparnaturalNodeShape: sns,
    }));

    // Compute a common shape: prefix to shorten all URIs in the table
    const allUris = [
      ...categoryA.map((c) => c.id),
      ...categoryB.map((c) => c.id),
      ...[...categoryA, ...categoryB].flatMap((cls) =>
        cls.sparnaturalNodeShape
          .getValidProperties()
          .map((p: PropertyShape) => p.resource.value),
      ),
    ];
    const shapePrefix = this.computeShapePrefix(allUris);
    const abbrev = (uri: string): string =>
      shapePrefix ? uri.replace(shapePrefix, "shape:") : uri;

    // Build the reference table
    let finalModel = "\n\n## 8d. SHACL-Derived Reference Table\n\n";

    // Declare the shape: prefix if one was found
    if (shapePrefix) {
      finalModel += `PREFIX shape: <${shapePrefix}>\n`;
      finalModel += `IMPORTANT: In this table all URIs are abbreviated with the prefix above.\n`;
      finalModel += `When writing JSON output, always expand "shape:X" to its full form: "${shapePrefix}X".\n\n`;
    }

    // Category A
    finalModel +=
      '### CATEGORY A — ROOT SUBJECT classes (can be the root "subject" of the query AND can appear as object variables):\n\n';
    categoryA.forEach((cls) => {
      const desc = cls.description ? ` described as "${cls.description}"` : "";
      finalModel += `- ${abbrev(cls.id)} (${cls.label})${desc}\n`;
    });

    // Category B
    finalModel +=
      '\n### CATEGORY B — NON-ROOT classes (cannot be the root "subject" of the query, but can appear as object variables in traversal paths):\n\n';
    finalModel +=
      "These classes CANNOT be the root subject of the query (where.subject).\n";
    finalModel +=
      "They CAN appear as object variables (rdfType on ObjectCriteria.variable) in nested predicateObjectPairs,\n";
    finalModel +=
      "when the traversal path leads to them through a property declared in the SHACL model.\n\n";

    categoryB.forEach((cls) => {
      const desc = cls.description ? ` described as "${cls.description}"` : "";
      finalModel += `- ${abbrev(cls.id)} (${cls.label})${desc}\n`;
    });

    // Property Reference Table
    finalModel += "\n### PROPERTY REFERENCE TABLE (for all classes):\n\n";
    finalModel += "**HOW TO READ THIS TABLE:**\n";
    finalModel += "Each property entry follows this format:\n";
    finalModel +=
      "  `<property-shape-URI> | <name> | <range-type> | <usage> | <description>`\n\n";
    finalModel += "**range-type** is one of:\n";
    finalModel +=
      '  - "" (empty) if the property has no range or a complex range not directly filterable\n';
    finalModel +=
      '  - "<ClassName> (Cat.A)" -> IRI pointing to a Category A class; set rdfType on the object variable\n';
    finalModel +=
      '  - "<ClassName> (Cat.B)" -> IRI pointing to a Category B class; continue traversal with nested predicateObjectPairs\n\n';
    finalModel += "**usage** is one or more of:\n";
    finalModel +=
      "  - [values]              -> the user typically names a specific entity; use values[] with URI_NOT_FOUND\n";
    finalModel +=
      "  - [filter:date]         -> the user gives a date range; use a dateFilter in filters[]\n";
    finalModel +=
      "  - [filter:search]       -> the user gives a keyword; use a searchFilter in filters[]\n";
    finalModel +=
      "  - [filter:Number]       -> the user gives a number; use a numberFilter in filters[]\n";
    finalModel +=
      "  - [filter:Map]          -> the user gives coordinates; use mapFilter in filters[]\n";
    finalModel +=
      "  - [predicateObjectPairs] -> this property is used to navigate to a deeper class, not filtered directly\n\n";

    // Build property tables — only for classes that have valid properties
    [...categoryA, ...categoryB].forEach((cls) => {
      const validProps = cls.sparnaturalNodeShape.getValidProperties();
      if (validProps.length === 0) return;

      finalModel += `\n**${abbrev(cls.id)}** (${cls.label})\n`;
      if (cls.agentInstruction) {
        finalModel += `> ${cls.agentInstruction}\n`;
      }
      finalModel += this.buildPropertyTable(
        cls.sparnaturalNodeShape,
        entryPointIds,
        language,
        abbrev,
      );
    });

    return finalModel;
  }

  /** Build the detailed property table for a SparnaturalNodeShape. */
  private buildPropertyTable(
    sns: SparnaturalNodeShape,
    entryPointIds: Set<string>,
    language: string,
    abbrev: (uri: string) => string,
  ): string {
    const validProperties: PropertyShape[] = sns.getValidProperties();
    let table = "";

    validProperties.forEach((propShape: PropertyShape) => {
      const propUri = abbrev(propShape.resource.value);
      const label = propShape.getLabel(language) ?? "unknown";
      const tooltip = T2QPromptGenerator.stripMarkdown(
        propShape.getTooltip(language),
      );

      const spps = new SparnaturalPropertyShape(propShape);
      const rangeShapes: NodeShape[] = spps.getRangeShapes();

      let rangeType = "";
      const usages: string[] = [];

      if (rangeShapes.length > 1) {
        rangeType = "";
        usages.push("[values]");
      } else if (rangeShapes.length === 1 && rangeShapes[0]) {
        const rangeNS = rangeShapes[0];
        const rangeId = rangeNS.resource.value;
        const rangeLabel = rangeNS.getLabel(language) ?? abbrev(rangeId);
        const category = entryPointIds.has(rangeId) ? "Cat.A" : "Cat.B";
        rangeType = `${rangeLabel} (${category})`;

        const rangeSnS = new SparnaturalNodeShape(rangeNS);
        if (rangeSnS.getValidProperties().length > 0) {
          usages.push("[predicateObjectPairs]");
        }

        const widgetUsage = this.getWidgetUsage(propShape, rangeNS.resource);
        if (widgetUsage) {
          usages.push(widgetUsage);
        }
      } else {
        const widgetUsage = this.getWidgetUsage(propShape, undefined);
        if (widgetUsage) {
          usages.push(widgetUsage);
        }
      }

      if (usages.length === 0) {
        usages.push("");
      }

      const usage = usages.join("");
      table += `- ${propUri} | ${label} | ${rangeType} | ${usage} | ${tooltip}\n`;
    });

    return table;
  }

  /** Returns the widget-based usage string, or null if NON_SELECTABLE. */
  private getWidgetUsage(
    propShape: PropertyShape,
    rangeResource: Resource | undefined,
  ): string | null {
    const searchWidget: SearchWidgetIfc =
      propShape.getSearchWidgetForRange(rangeResource);
    const widgetUri = searchWidget.getResource().value;
    if (widgetUri === SPARNATURAL.NON_SELECTABLE_PROPERTY.value) {
      return null;
    } else if (
      widgetUri === SPARNATURAL.TIME_PROPERTY_DATE.value ||
      widgetUri === SPARNATURAL.TIME_PROPERTY_YEAR.value
    ) {
      return "[filter:date]";
    } else if (
      widgetUri === SPARNATURAL.SEARCH_PROPERTY.value ||
      widgetUri === SPARNATURAL.STRING_EQUALS_PROPERTY.value
    ) {
      return "[filter:search]";
    } else if (widgetUri === SPARNATURAL.NUMBER_PROPERTY.value) {
      return "[filter:Number]";
    } else if (widgetUri === SPARNATURAL.MAP_PROPERTY.value) {
      return "[filter:Map]";
    } else {
      return "[values]";
    }
  }
}
