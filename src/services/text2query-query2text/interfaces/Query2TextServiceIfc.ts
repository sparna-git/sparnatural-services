import { injectable } from "tsyringe";

export interface Query2TextServiceIfc {
  generateSummary(jsonQuery: object, lang: string): Promise<string>;
}

@injectable({ token: "NoOpQuery2TextService" })
export class NoOpQuery2TextService implements Query2TextServiceIfc {
  generateSummary(jsonQuery: object, lang: string): Promise<string> {
    throw new Error("Method not implemented.");
  }
}
