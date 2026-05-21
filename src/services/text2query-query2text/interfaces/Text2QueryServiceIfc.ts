import { injectable } from "tsyringe";
// import { z } from "zod";
// import { SparnaturalQuery } from "../../models/SparnaturalQuery";

export interface Text2QueryServiceIfc {
  // before it was: Promise<z.infer<typeof SparnaturalQuery>>
  generateJson(
    naturalLanguageQuery: string,
    skipReconciliation?: boolean,
  ): Promise<JSON>;
}

@injectable({ token: "NoOpText2QueryService" })
export class NoOpText2QueryService implements Text2QueryServiceIfc {
  // before it was: Promise<z.infer<typeof SparnaturalQuery>>
  generateJson(
    naturalLanguageQuery: string,
    skipReconciliation?: boolean,
  ): Promise<JSON> {
    throw new Error("Method not implemented.");
  }
}
