import lunr from "lunr";

// Strips diacritics so "eplerenone" matches "éplérénone" in both directions.
// Registered globally once; must be imported before any index build or load.
export const normalizeAccents = (token: lunr.Token): lunr.Token =>
  token.update((str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

lunr.Pipeline.registerFunction(normalizeAccents, "normalizeAccents");
