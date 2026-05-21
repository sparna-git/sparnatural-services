export type SearchMode = "wildcard" | "fuzzy" | "exact";
export type SparqlBinding = Record<string, { value: string }>;
export type FieldBinding = { entity: string; value: string };
export type LegacyBinding = { id: string; label?: string; altLabel?: string };
export type UriData = { label: string; fields: Record<string, string[]>; types?: string[] };
