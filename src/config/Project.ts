import { inject, injectable } from "tsyringe";
import {
  NoOpQuery2TextService,
  Query2TextServiceIfc,
} from "../services/text2query-query2text/interfaces/Query2TextServiceIfc";
import {
  NoOpText2QueryService,
  Text2QueryServiceIfc,
} from "../services/text2query-query2text/interfaces/Text2QueryServiceIfc";
import {
  NoOpReconcileService,
  ReconcileServiceIfc,
} from "../services/reconciliation/interfaces/ReconcileServiceIfc";

import {
  Q2TPromptGeneratorIfc,
  NoOpQ2TPromptGenerator,
} from "../services/prompts/interfaces/Q2TPromptGeneratorIfc";
import {
  T2QPromptGeneratorIfc,
  NoOpT2QPromptGenerator,
} from "../services/prompts/interfaces/T2QPromptGeneratorIfc";

@injectable({ token: "Project" })
export class Project {
  public projectId: string;
  public sparqlEndpoint: string;
  public reconcileService: ReconcileServiceIfc;
  public text2queryService: Text2QueryServiceIfc;
  public query2textService: Query2TextServiceIfc;
  public promptGeneratorQ2TService: Q2TPromptGeneratorIfc;
  public promptGeneratorT2QService: T2QPromptGeneratorIfc;

  constructor(
    @inject("project.id") projectId: string,
    @inject("project.sparqlEndpoint") sparqlEndpoint: string,
    @inject("reconciliation") reconcileService?: ReconcileServiceIfc,
    @inject("text2query") text2queryService?: Text2QueryServiceIfc,
    @inject("query2text") query2textService?: Query2TextServiceIfc,
    @inject("q2tPromptGenerator")
    promptGeneratorQ2TService?: Q2TPromptGeneratorIfc,
    @inject("t2qPromptGenerator")
    promptGeneratorT2QService?: T2QPromptGeneratorIfc,
  ) {
    if (!reconcileService) {
      console.warn(
        `No reconciliation service was passed in constructor or ${projectId}`,
      );
    }
    this.projectId = projectId;
    this.sparqlEndpoint = sparqlEndpoint;
    this.reconcileService = reconcileService || new NoOpReconcileService();
    this.text2queryService = text2queryService || new NoOpText2QueryService();
    this.query2textService = query2textService || new NoOpQuery2TextService();
    this.promptGeneratorQ2TService =
      promptGeneratorQ2TService || new NoOpQ2TPromptGenerator();
    this.promptGeneratorT2QService =
      promptGeneratorT2QService || new NoOpT2QPromptGenerator();
  }
}
