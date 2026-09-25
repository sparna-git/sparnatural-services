import { RDFS, SH } from "rdf-shacl-commons";
import type { NodeShape, Resource, ShaclModel } from "rdf-shacl-commons";
import { DataFactory } from "rdf-data-factory";

const _rdfFactory = new DataFactory();
const KEY_SHAPE_PRED = _rdfFactory.namedNode(
  "http://data.sparna.fr/ontologies/sparnatural-config-core#keyShape",
);

const SKOS_NOTATION = "http://www.w3.org/2004/02/skos/core#notation";
const DCT_IDENTIFIER = "http://purl.org/dc/terms/identifier";
const SKOS_EXACT_MATCH = "http://www.w3.org/2004/02/skos/core#exactMatch";

// Names of properties that look like identifiers when paired with a required
// xsd:string datatype. Kept intentionally loose so app-specific identifiers
// (med:CIS, med:CIP13, med:codeUCD13, etc.) are picked up without annotation.
const IDENTIFIER_NAME_REGEX = /identif|code|cis|cip|ucd/i;

export interface KeyRelation {
  path: string;
  targetShape: string;
  targetShapeLabel?: string;
}

export interface NodeShapeOverviewInfo {
  shapeIri: string;
  label?: string;
  description?: string;
  targetClasses: string[];
  /** `sh:select` of the shape's SPARQL target, when it has no target class. */
  targetSelect?: string;
  order?: number;
  keyShape?: boolean;
  // Key-property heuristic results (see extractNodeShapesOverview)
  labelPath?: string;
  identifierPaths: string[];
  keyRelations: KeyRelation[];
  externalMatchPaths: string[];
  // Full topology, kept for future overview sections
  objectProperties: Array<{
    path: string;
    targetClasses: string[];
  }>;
  dataProperties: string[];
}

export interface NodeShapeInfo {
  shapeIri: string;
  label?: string;
  description?: string;
  agentInstruction?: string;
  targetClasses: string[];
  targetSparql?: string[];
  properties: PropertyShapeInfo[];
}

export interface PropertyShapeInfo {
  path?: string;
  name?: string;
  description?: string;
  agentInstruction?: string;
  minCount?: number;
  maxCount?: number;
  classes?: string[];
  /** `sh:node`: the shape the values conform to. A shape IRI, not a class. */
  targetShape?: string[];
  datatypes?: string[];
  values?: string[];
}

/**
 * Tries the preferred language first, then iterates over every language
 * present in the model until a non-empty value is found.
 */
function getTooltipWithFallback(
  shape: { getTooltip: (lang: string) => string | undefined },
  preferredLang: string,
  allLangs: string[],
): string | undefined {
  const preferred = shape.getTooltip(preferredLang);
  if (preferred) return preferred;
  for (const lang of allLangs) {
    if (lang === preferredLang) continue;
    const value = shape.getTooltip(lang);
    if (value) return value;
  }
  return undefined;
}

function getAgentInstructionWithFallback(
  shape: { getShAgentInstruction: (lang: string) => string[] | undefined },
  preferredLang: string,
  allLangs: string[],
): string[] | undefined {
  const preferred = shape.getShAgentInstruction(preferredLang);
  if (preferred?.length) return preferred;
  for (const lang of allLangs) {
    if (lang === preferredLang) continue;
    const value = shape.getShAgentInstruction(lang);
    if (value?.length) return value;
  }
  return undefined;
}

/**
 * Label in the preferred language, or in any other language of the model.
 *
 * The property is read directly because `getLabel()` never returns undefined:
 * it falls back to the local name of the IRI, which would hide a label written
 * in another language. The EP shapes, for instance, are labelled in English
 * only, and the default language is French.
 */
function getLabelWithFallback(
  shape: {
    getLabel: (lang: string) => string | undefined;
    getResource: () => Resource;
  },
  preferredLang: string,
  allLangs: string[],
  model: ShaclModel,
  labelProperty: Resource,
): string | undefined {
  for (const lang of [preferredLang, ...allLangs]) {
    const value = model.readSinglePropertyInLang(
      shape.getResource(),
      labelProperty,
      lang,
    )?.value;
    if (value) return value;
  }
  return shape.getLabel(preferredLang);
}

/**
 * Parses @prefix declarations from a Turtle string.
 * Returns [uri, "prefix:"] pairs sorted longest-URI first so compact()
 * always matches the most specific prefix.
 */
export function extractPrefixesFromTtl(ttl: string): [string, string][] {
  const map: Record<string, string> = {};
  const regex = /@prefix\s+([\w-]*:)\s*<([^>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(ttl)) !== null) {
    map[m[2]] = m[1];
  }
  return Object.entries(map).sort(([a], [b]) => b.length - a.length);
}

function compact(
  iri: string | undefined,
  prefixes: [string, string][],
): string | undefined {
  if (!iri) return undefined;
  for (const [uri, prefix] of prefixes) {
    if (iri.startsWith(uri)) return prefix + iri.slice(uri.length);
  }
  return iri;
}

/** The `sh:select` of a shape's SPARQL target, if it has one. */
function readTargetSelect(
  nodeShape: NodeShape,
  model: ShaclModel,
): string | undefined {
  for (const target of nodeShape.getShTarget()) {
    const select = model.readSinglePropertyAsString(target, SH.SELECT)?.trim();
    if (select) return select;
  }
  return undefined;
}

/**
 * Where an object property points: `sh:class` names the target class,
 * `sh:node` the target shape. Overview only — a `sh:node` is a shape name,
 * not an `rdf:type`.
 */
function rangeOf(ps: {
  getShClass: () => Resource[];
  getShNode: () => Resource[];
}): Resource[] {
  const classes = ps.getShClass();
  return classes.length > 0 ? classes : ps.getShNode();
}

// True if this property shape carries an "identifier" semantics under our
// heuristic. Purely semantic — cardinality is irrelevant (CIP7 is optional
// but still an identifier).
//   1. Canonical: sh:path = skos:notation or dct:identifier.
//   2. Datatype property (sh:datatype set, and neither sh:class nor sh:node)
//      whose sh:name matches the identifier name regex
//      (identif | code | CIS | CIP | UCD).
function isIdentifierProperty(
  ps: any,
  pathRaw: string | undefined,
  name: string | undefined,
  hasClass: boolean,
): boolean {
  if (pathRaw === SKOS_NOTATION || pathRaw === DCT_IDENTIFIER) return true;

  // Object properties (sh:class or sh:node set) are relations, not identifiers.
  if (hasClass) return false;

  const datatypes = ps.getShDatatype?.() ?? [];
  if (datatypes.length === 0) return false;

  return name ? IDENTIFIER_NAME_REGEX.test(name) : false;
}

/**
 * Compact topology + key-property representation of every NodeShape.
 *
 * Two passes:
 *   1) collect every NodeShape IRI declared in the model (and which are also
 *      flagged as config-core:keyShape — kept as a boolean for downstream
 *      consumers, not used for filtering anymore);
 *   2) for each shape, derive the heuristic "key properties":
 *        - labelPath           : dash:propertyRole dash:LabelRole, falling
 *                                back to rdfs:label / skos:prefLabel via
 *                                NodeShape.getDefaultLabelProperty();
 *        - identifierPaths     : semantic identifier heuristic — sh:path is
 *                                skos:notation/dct:identifier, OR datatype
 *                                property whose sh:name matches
 *                                IDENTIFIER_NAME_REGEX (cardinality is NOT
 *                                considered: optional identifiers like CIP7
 *                                must be captured);
 *        - keyRelations        : object properties whose target class is any
 *                                NodeShape declared in the model (no longer
 *                                restricted to keyShapes);
 *        - externalMatchPaths  : sh:path = skos:exactMatch.
 *
 * Full topology (objectProperties / dataProperties) is also returned to
 * support future overview sections without re-walking the model.
 */
export function extractNodeShapesOverview(
  model: ShaclModel,
  lang = "fr",
  prefixes: [string, string][] = [],
): NodeShapeOverviewInfo[] {
  const c = (iri: string | undefined) =>
    prefixes.length ? compact(iri, prefixes) : iri;

  const allLangs = model.readAllLanguages();
  const allShapes = model.readAllNodeShapes();

  // Pass 1: collect every NodeShape IRI (so we can recognise structural
  // relations), the keyShape flag (informational), and a label lookup.
  const allShapeRawIris = new Set<string>();
  const keyShapeRawIris = new Set<string>();
  const labelByRawIri = new Map<string, string>();
  for (const ns of allShapes) {
    const rawIri = ns.getResource().value;
    allShapeRawIris.add(rawIri);
    const keyVals = model.readProperty(ns.getResource(), KEY_SHAPE_PRED);
    if (keyVals.some((t) => t.value === "true")) {
      keyShapeRawIris.add(rawIri);
    }
    const lbl = getLabelWithFallback(ns, lang, allLangs, model, RDFS.LABEL);
    if (lbl) labelByRawIri.set(rawIri, lbl);
  }

  // Pass 2: build the overview entries.
  return allShapes.map((ns) => {
    const rawIri = ns.getResource().value;
    const shapeIri = c(rawIri)!;
    const targetClasses = ns.getTargetClasses().map((r) => c(r.value)!);

    const orderTerm = ns.getShOrder();
    const order = orderTerm ? Number(orderTerm.value) : undefined;

    const keyShape = keyShapeRawIris.has(rawIri) ? true : undefined;

    const objectProperties: Array<{ path: string; targetClasses: string[] }> =
      [];
    const dataProperties: string[] = [];

    const identifierPaths: string[] = [];
    const keyRelations: KeyRelation[] = [];
    const externalMatchPaths: string[] = [];

    for (const ps of ns.getProperties()) {
      const pathRaw = ps.getShPath()?.value;
      const path = c(pathRaw);
      if (!path) continue;

      const psName = getLabelWithFallback(ps, lang, allLangs, model, SH.NAME);
      const classResources = rangeOf(ps);
      const classesRaw = classResources.map((r) => r.value);
      const classesCompact = classesRaw.map((v) => c(v)!);
      const hasClass = classesCompact.length > 0;

      if (hasClass) {
        objectProperties.push({ path, targetClasses: classesCompact });

        // Structural relation if any target is itself a NodeShape declared in
        // the model: a sh:class named after its shape (Forme, Voie, Dosage*…)
        // or a sh:node, which always points at a shape.
        for (let i = 0; i < classesRaw.length; i++) {
          const targetRaw = classesRaw[i];
          if (!allShapeRawIris.has(targetRaw)) continue;
          keyRelations.push({
            path,
            targetShape: classesCompact[i],
            targetShapeLabel: labelByRawIri.get(targetRaw),
          });
        }
      } else {
        dataProperties.push(path);
      }

      if (pathRaw === SKOS_EXACT_MATCH) {
        externalMatchPaths.push(path);
      }

      if (isIdentifierProperty(ps, pathRaw, psName, hasClass)) {
        identifierPaths.push(path);
      }
    }

    // Label property: prefer dash:propertyRole dash:LabelRole, fall back to
    // the SHACL-commons default lookup (skos:prefLabel, rdfs:label, …).
    const defaultLabelProp = (ns as any).getDefaultLabelProperty?.();
    const labelPath = defaultLabelProp
      ? c(defaultLabelProp.getShPath?.()?.value)
      : undefined;

    const targetSelect =
      targetClasses.length === 0 ? readTargetSelect(ns, model) : undefined;

    const shape: NodeShapeOverviewInfo = {
      shapeIri,
      label: labelByRawIri.get(rawIri),
      description: getTooltipWithFallback(ns, lang, allLangs),
      targetClasses,
      targetSelect,
      objectProperties,
      dataProperties,
      labelPath,
      identifierPaths,
      keyRelations,
      externalMatchPaths,
    };

    if (order !== undefined) shape.order = order;
    if (keyShape) shape.keyShape = keyShape;

    return shape;
  });
}

/**
 * Extract a LLM-friendly JSON representation of all NodeShapes found in the
 * given ShaclModel. Uses rdf-shacl-commons to hide RDF/SHACL plumbing.
 * When prefixes are provided, all IRIs are compacted to their prefixed form.
 */
export function extractNodeShapes(
  model: ShaclModel,
  lang = "fr",
  prefixes: [string, string][] = [],
): NodeShapeInfo[] {
  const c = (iri: string | undefined) =>
    prefixes.length ? compact(iri, prefixes) : iri;

  // Discover every language present in this SHACL file at runtime.
  const allLangs = model.readAllLanguages();

  return model.readAllNodeShapes().map((ns) => {
    const shapeIri = c(ns.getResource().value)!;

    const targetClasses = ns.getTargetClasses().map((r) => c(r.value)!);
    // The query itself, not the IRI of the sh:target node, which says nothing.
    const targetSelect = readTargetSelect(ns, model);

    const nsDescription = getTooltipWithFallback(ns, lang, allLangs);
    const nsAgentInstr = getAgentInstructionWithFallback(ns, lang, allLangs);

    const properties: PropertyShapeInfo[] = ns.getProperties().map((ps) => {
      const path = ps.getShPath();

      // sh:class uniquement : le champ "classes" est annoncé à l'agent comme
      // des IRI de rdf:type à mettre dans ses requêtes. Une cible sh:node est
      // un nom de shape, pas un type, et produirait une requête sans résultat.
      const classes = ps.getShClass().map((r) => c(r.value)!);
      const targetShapes = ps.getShNode().map((r) => c(r.value)!);
      const datatypes = ps.getShDatatype().map((d) => c(d.getUri().value)!);

      const shIn = ps.getShIn();
      const values = shIn?.map((t) => c(t.value)!);

      const psDescription = getTooltipWithFallback(ps, lang, allLangs);
      const psAgentInstr = getAgentInstructionWithFallback(ps, lang, allLangs);

      const prop: PropertyShapeInfo = {
        path: c(path?.value),
        name: getLabelWithFallback(ps, lang, allLangs, model, SH.NAME),
      };

      if (psDescription) prop.description = psDescription;
      if (psAgentInstr?.length) prop.agentInstruction = psAgentInstr.join(" ");
      if (ps.getShMinCount() != null) prop.minCount = ps.getShMinCount();
      if (ps.getShMaxCount() != null) prop.maxCount = ps.getShMaxCount();
      if (classes.length) prop.classes = classes;
      if (targetShapes.length) prop.targetShape = targetShapes;
      if (datatypes.length) prop.datatypes = datatypes;
      if (values?.length) prop.values = values;

      return prop;
    });

    const shape: NodeShapeInfo = {
      shapeIri,
      label: getLabelWithFallback(ns, lang, allLangs, model, RDFS.LABEL),
      targetClasses,
      properties,
    };

    if (nsDescription) shape.description = nsDescription;
    if (nsAgentInstr?.length) shape.agentInstruction = nsAgentInstr.join(" ");
    if (targetSelect) shape.targetSparql = [targetSelect];

    return shape;
  });
}
