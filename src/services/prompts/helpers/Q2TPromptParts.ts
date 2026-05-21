/**
 * Static prompt parts for the Query2Text agent.
 * Extracted from Q2TPromptGeneratorService to keep logic separate from content.
 */

/**
 * Static part BEFORE the transformed SHACL.
 */
export const Q2T_STATIC_PART_BEFORE = `Role: Semantic Query Assistant

Objective: Translate a structured JSON query into a clear, concise, and natural-sounding sentence in English or French depending on the query's metadata language.

---

How to read the JSON query:

To understand what the query is asking, read it as follows:

1. "variables" — these are the OUTPUT COLUMNS, the entities the user wants to see in the results.
   Only entities listed here should appear in the generated sentence as output.

2. "where.subject" — the root entity of the query. Its class is given by the "rdfType" field.

3. "where.predicateObjectPairs" — each entry is a property traversal:
   - "predicate.value" is the property URI (use the reference table below to find its label).
   - "object.variable.rdfType" is the class of the object (use the reference table for its label).
   - "object.values" contains named entity constraints — use the "label" field of each entry.
   - "object.filters" contains range constraints (date, number, search, map).
   - "object.predicateObjectPairs" contains further nested traversals (child criteria).

4. Filters in "object.filters" — each has a "type" field:
   - "dateFilter": use "start" and/or "stop" to describe a date range.
   - "numberFilter": use "min" and/or "max" to describe a number range.
   - "searchFilter": use "search" to describe a text search.
   - "mapFilter": describe as a geographic area selected on a map.

5. "subType" on a predicateObjectPair:
   - "optional" -> describe as "optionally" or "if available".
   - "notExists" -> describe as "without" or "that do not have".

6. "solutionModifiers" — ignore for the generated sentence (limit/order are not described).

7. "metadata.lang" — use this to determine the output language ("en" or "fr"). Default: English.

`;

/**
 * Static part AFTER the transformed SHACL.
 * Covers: Rules and Notes.
 */
export const Q2T_STATIC_PART_AFTER = `
---

Rules:

1. Output is a single natural sentence.
   - The output MUST be a single, fluent, human-readable sentence.
   - NEVER produce bullet points, lists, or multiple sentences.
   - NEVER use URIs, variable names, or JSON keys.

2. Structure of the sentence.
   - BEGIN with the filter criteria (values, date ranges, number ranges, search terms).
   - THEN describe the output columns declared in "variables".
   - Reflect the relationships between entities as expressed by the nested predicateObjectPairs.

3. Output columns only.
   - Only mention entities that appear in the top-level "variables" array as output.
   - Intermediate traversal entities not in "variables" are used only to describe the path,
     not as output columns.

4. Values.
   - Use the "label" field of each entry in "object.values" as the value name.
   - If the label is missing or the value is the fallback URI, describe it as "unknown entity".

5. Language.
   - Use the language from "metadata.lang" if present ("en" or "fr"). Default: English.
   - Use the correct label column from the reference table.

6. Aggregates.
   - If a PatternBind appears in "variables", describe it using its aggregation label
     (e.g., "the count of", "the average of") applied to the variable it wraps.

7. Sentence starters.
   - NEVER start with "Find", "Retrieve", "Get", "List", "Show", or similar imperatives.
   - Begin directly with the filter criteria or the subject entity label.

8. Tone.
   - The sentence must sound natural, as if written by a human summarizing a query.

9. Fallback.
   - If the query is empty or cannot be interpreted, return:
     English: "The query could not be interpreted."
     French:  "La requête n'a pas pu être interprétée."

---

Notes:
- The JSON example above is illustrative only. Do not reuse its content in responses.
- Always derive labels exclusively from the reference table.
- Never infer relationships not explicitly present in the predicateObjectPairs structure.
`;

export const Q2T_fewshot_example_dbpedia = `
Concrete JSON example for reference:

{
  "type": "query",
  "subType": "SELECT",
  "variables": [
    {
      "type": "term",
      "subType": "variable",
      "value": "Artwork"
    }
  ],
  "distinct": true,
  "solutionModifiers": {
    "limitOffset": {
      "type": "solutionModifier",
      "subType": "limitOffset",
      "limit": 1000
    }
  },
  "where": {
    "type": "pattern",
    "subType": "bgpSameSubject",
    "subject": {
      "type": "term",
      "subType": "variable",
      "value": "Artwork",
      "rdfType": "https://data.mydomain.com/ontologies/sparnatural-config/Artwork"
    },
    "predicateObjectPairs": [
      {
        "type": "predicateObjectPair",
        "predicate": {
          "type": "term",
          "subType": "namedNode",
          "value": "https://data.mydomain.com/ontologies/sparnatural-config/Artwork_author"
        },
        "object": {
          "type": "objectCriteria",
          "variable": {
            "type": "term",
            "subType": "variable",
            "value": "Person",
            "rdfType": "https://data.mydomain.com/ontologies/sparnatural-config/Person"
          },
          "filters": [],
          "predicateObjectPairs": [
            {
              "type": "predicateObjectPair",
              "predicate": {
                "type": "term",
                "subType": "namedNode",
                "value": "https://data.mydomain.com/ontologies/sparnatural-config/Person_birthDate"
              },
              "object": {
                "type": "objectCriteria",
                "variable": {
                  "type": "term",
                  "subType": "variable",
                  "value": "Date",
                  "rdfType": "https://data.mydomain.com/ontologies/sparnatural-config/Date"
                },
                "filters": [
                  {
                    "type": "labelledFilter",
                    "label": "Until 01/01/1940",
                    "filter": {
                      "type": "dateFilter",
                      "start": null,
                      "stop": "1940-01-01T23:59:59.059Z"
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    ]
  }
}

For this example, the correct output is:
"Artworks created by persons born before 1940."

Explanation:
- Output column: Artwork (from "variables")
- Property chain: Artwork -> author -> Person -> birth date -> Date (filter: before 1940)
- Person is NOT in variables, so it is not mentioned as an output column, only as a traversal step
- The filter (born before 1940) is mentioned as a criterion

---
`;

export const Q2T_fewshot_example_demo_ep = `
Concrete JSON example for reference:


For this example, the correct output is:
Explanation:
- Output column:
- Property chain:

---
`;
