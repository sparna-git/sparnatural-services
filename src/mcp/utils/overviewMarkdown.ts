import type { NodeShapeOverviewInfo } from "./shaclParser";
import type { UseCase } from "../../config/ProjectConfig";

export interface OverviewMeta {
  title?: string;
  description?: string;
  agentInstruction?: string;
}

export interface OverviewBuildInput {
  projectId: string;
  lang: string;
  meta: OverviewMeta;
  shapes: NodeShapeOverviewInfo[];
  prefixes: Record<string, string>;
  useCases?: UseCase[];
}

/**
 * A section builder receives the full overview input and returns a Markdown
 * fragment. Return `undefined` (or an empty string) to skip the section.
 *
 * The pipeline is extensible: pass additional builders via `extraSections`
 * on `buildSchemaOverviewMarkdown` to inject new sections without touching
 * existing ones.
 */
export type SectionBuilder = (input: OverviewBuildInput) => string | undefined;

const DEFAULT_SECTIONS: SectionBuilder[] = [
  headerSection,
  nodeShapesSection,
  useCasesSection,
];

export function buildSchemaOverviewMarkdown(
  input: OverviewBuildInput,
  extraSections: SectionBuilder[] = [],
): string {
  const all = [...DEFAULT_SECTIONS, ...extraSections];
  return all
    .map((section) => section(input))
    .filter((text): text is string => !!text && text.trim().length > 0)
    .join("\n\n");
}

// ─── Sections ────────────────────────────────────────────────────────────────

function headerSection({ projectId, meta }: OverviewBuildInput): string {
  const lines: string[] = [];
  lines.push(`# Schema overview — \`${projectId}\``);
  if (meta.title) lines.push(`*${meta.title}*`);
  if (meta.description) lines.push(meta.description);
  if (meta.agentInstruction) {
    lines.push(`> **Agent instruction.** ${meta.agentInstruction}`);
  }
  return lines.join("\n\n");
}

function nodeShapesSection(input: OverviewBuildInput): string | undefined {
  const shapes = [...input.shapes]
    .filter((s) => !isEmptyShape(s))
    .sort(orderThenLabel);
  if (shapes.length === 0) return undefined;

  const blocks = shapes.map((s) => renderShapeBlock(s));
  return [
    "## NodeShapes",
    "Toutes les NodeShapes du modèle avec leur description et la liste des shapes liées. Pour chaque shape impliquée dans une requête SPARQL, appelez `discover_nodeshapes` afin d'obtenir les paths concrets, cardinalités, datatypes, valeurs autorisées et agent instructions — **sauf si cette shape a déjà été découverte plus tôt dans la conversation**. Inutile de re-découvrir une shape déjà obtenue.",
    blocks.join("\n\n"),
  ].join("\n\n");
}

function isEmptyShape(s: NodeShapeOverviewInfo): boolean {
  return (
    !s.description &&
    s.keyRelations.length === 0 &&
    s.identifierPaths.length === 0 &&
    !s.labelPath &&
    s.externalMatchPaths.length === 0
  );
}

function useCasesSection(input: OverviewBuildInput): string | undefined {
  const cases = input.useCases ?? [];
  if (cases.length === 0) return undefined;

  const tableRows = cases
    .map(
      (uc) =>
        `| ${escapeCell(uc.title)} | ${escapeCell(uc.entryPoint ?? "—")} | ${escapeCell(uc.joins ?? "—")} |`,
    )
    .join("\n");

  return [
    "## Cas d'usage typiques",
    "Patterns de requête récurrents : par quelle NodeShape entrer dans le graphe, et quelles jointures suivre. **Pas de SPARQL ni de valeurs littérales** — utilisez `discover_nodeshapes` pour plus d'informations.",
    "| Cas d'usage | Point d'entrée | Jointures clés |\n|---|---|---|",
    tableRows,
  ].join("\n\n");
}

// Markdown table cells must not contain raw '|' nor newlines.
function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderShapeBlock(s: NodeShapeOverviewInfo): string {
  const heading = s.label
    ? `### ${s.label} (\`${s.shapeIri}\`)`
    : `### \`${s.shapeIri}\``;

  const lines: string[] = [heading];

  const targetClassDiffers =
    s.targetClasses.length > 0 &&
    !s.targetClasses.every((c) => c === s.shapeIri);
  if (targetClassDiffers) {
    lines.push(
      `**Target class** : ${s.targetClasses.map((c) => `\`${c}\``).join(", ")}`,
    );
  }

  if (s.description) lines.push(s.description.trim());

  if (s.keyRelations.length > 0) {
    const targets = dedupeRelationTargets(s.keyRelations);
    lines.push(`**Lié à** : ${targets.join(", ")}`);
  }

  return lines.join("\n\n");
}

function dedupeRelationTargets(
  rels: NodeShapeOverviewInfo["keyRelations"],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rels) {
    const name = r.targetShapeLabel ?? r.targetShape;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function orderThenLabel(
  a: NodeShapeOverviewInfo,
  b: NodeShapeOverviewInfo,
): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  const al = (a.label ?? a.shapeIri).toLowerCase();
  const bl = (b.label ?? b.shapeIri).toLowerCase();
  return al.localeCompare(bl);
}
