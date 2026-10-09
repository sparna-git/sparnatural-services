import type { ReconciliationServiceConfig } from "kgcompass";

export interface AppConfig {
  log?: {
    directory: string;
  };
  projects: Record<string, ProjectConfig>;
}

export interface ProjectConfig {
  sparqlEndpoint: string;
  shaclTypes?: string[];
  reconciliation?: ReconciliationServiceConfig | ReconciliationServiceConfig[];

  text2query?:
    | ({
        implementation: "MistralText2QueryService";
      } & MistralText2QueryServiceConfig)
    | ({
        implementation: "RestText2QueryService";
      } & RestQuery2TextServiceConfig);
  query2text?:
    | ({
        implementation: "MistralQuery2TextService";
      } & MistralQuery2TextServiceConfig)
    | ({
        implementation: "RestQuery2TextService";
      } & RestQuery2TextServiceConfig);
  promptGeneratorQ2T?: {
    implementation: "Q2TPromptGenerator";
  } & PromptGeneratorQ2TConfig;
  promptGeneratorT2Q?: {
    implementation: "T2QPromptGenerator";
  } & PromptGeneratorT2QConfig;
}

export interface MistralText2QueryServiceConfig {
  agentId: string;
}

export interface RestText2QueryServiceConfig {
  agentId: string;
}

export interface MistralQuery2TextServiceConfig {
  agentId: string;
}

export interface RestQuery2TextServiceConfig {
  agentId: string;
}

export interface PromptGeneratorQ2TConfig {
  language?: string;
  additionalInstructions?: string;
}

export interface PromptGeneratorT2QConfig {
  language?: string;
  additionalInstructions?: string;
}
