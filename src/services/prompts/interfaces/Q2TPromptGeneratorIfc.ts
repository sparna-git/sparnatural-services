import { injectable } from "tsyringe";

export interface Q2TPromptGeneratorIfc {
  generatePromptQ2T(projectKey: string, language: string): Promise<string>;
}

@injectable({ token: "NoOpQ2TPromptGenerator" })
export class NoOpQ2TPromptGenerator implements Q2TPromptGeneratorIfc {
  generatePromptQ2T(projectKey: string, language: string): Promise<string> {
    throw new Error("Method not implemented.");
  }
}
