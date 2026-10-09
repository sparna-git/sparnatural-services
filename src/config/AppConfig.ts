import "reflect-metadata";
import { container, DependencyContainer } from "tsyringe";
import { getReconcileService } from "kgcompass";
import { Project } from "./Project";
import { ProjectConfig } from "./ProjectConfig";
import { ConfigProvider } from "./ConfigProvider";
import { AppLogger } from "../utils/AppLogger";
import { MistralText2QueryService } from "../services/text2query-query2text/impl/MistralText2QueryService";
import { MistralQuery2TextService } from "../services/text2query-query2text/impl/MistralQuery2TextService";
import { RestText2QueryService } from "../services/text2query-query2text/impl/RestText2QueryService";
import { RestQuery2TextService } from "../services/text2query-query2text/impl/RestQuery2TextService";
import { Q2TPromptGenerator } from "../services/prompts/impl/Q2TPromptGeneratorService";
import { T2QPromptGenerator } from "../services/prompts/impl/T2QPromptGeneratorService";

export class AppConfig {
  private static instance: AppConfig;

  private config: any;
  private cache: Record<string, Project> = {};

  private constructor() {
    this.config = ConfigProvider.getInstance().getConfig();
    this.initContainer();
  }

  public static getInstance(): AppConfig {
    if (!AppConfig.instance) {
      AppConfig.instance = new AppConfig();
    }
    return AppConfig.instance;
  }

  listProjects(): string[] {
    return Object.keys(this.config.projects);
  }

  hasProject(projectKey: string): boolean {
    return this.config.projects.hasOwnProperty(projectKey);
  }

  getProject(projectKey: string): Project {
    if (this.cache[projectKey]) {
      return this.cache[projectKey];
    } else {
      if (!this.hasProject(projectKey)) {
        throw new Error(`Unknown project: ${projectKey}`);
      }

      let projectContainer = this.buildProjectContainer(projectKey);
      // resolve the project by is class, not by token, to get all dependencies injected
      let p: Project = projectContainer.resolve<Project>(Project);
      this.cache[projectKey] = p;

      console.dir(p);
      return p;
    }
  }

  getAppLogger() {
    return container.resolve<AppLogger>(AppLogger);
  }

  buildProjectContainer(projectKey: string): DependencyContainer {
    let projectContainer = container.createChildContainer();

    let projectConfig = this.config.projects[projectKey];
    // 1. register the project ID
    projectContainer.register<string>("project.id", { useValue: projectKey });
    // 2. register the complete project config
    projectContainer.register<ProjectConfig>("project.config", {
      useValue: projectConfig,
    });
    projectContainer.register<string>("project.sparqlEndpoint", {
      useValue: projectConfig.sparqlEndpoint,
    });
    // 3. The reconciliation service (single or chained) is built by KGCompass,
    // from the "reconciliation" section of the project in this same config file
    projectContainer.register("reconciliation", {
      useFactory: () => getReconcileService(projectKey),
    });

    // 5. Register the text2query service by its token, with its config
    projectContainer.register("text2query", {
      useToken:
        projectConfig.text2query?.implementation ?? "default:text2query",
    });
    projectContainer.register("text2query.config", {
      useValue: projectConfig.text2query ?? {},
    });

    // 6. Same thing to register query2text service
    projectContainer.register("query2text", {
      useToken:
        projectConfig.query2text?.implementation ?? "default:query2text",
    });
    projectContainer.register("query2text.config", {
      useValue: projectConfig.query2text ?? {},
    });

    // 7. Same thing to register Q2TPromptGenerator service
    projectContainer.register("q2tPromptGenerator", {
      useToken:
        projectConfig.q2tPromptGenerator?.implementation ??
        "default:q2tPromptGenerator",
    });
    projectContainer.register("q2tPromptGenerator.config", {
      useValue: projectConfig.q2tPromptGenerator ?? {},
    });

    // 8. Same thing to register T2QPromptGenerator service
    projectContainer.register("t2qPromptGenerator", {
      useToken:
        projectConfig.t2qPromptGenerator?.implementation ??
        "default:t2qPromptGenerator",
    });
    projectContainer.register("t2qPromptGenerator.config", {
      useValue: projectConfig.t2qPromptGenerator ?? {},
    });

    return projectContainer;
  }

  initContainer(): void {
    container.register("MistralText2QueryService", {
      useClass: MistralText2QueryService,
    });

    container.register("MistralQuery2TextService", {
      useClass: MistralQuery2TextService,
    });

    container.register("RestText2QueryService", {
      useClass: RestText2QueryService,
    });

    container.register("RestQuery2TextService", {
      useClass: RestQuery2TextService,
    });
    container.register("Q2TPromptGenerator", {
      useClass: Q2TPromptGenerator,
    });
    container.register("T2QPromptGenerator", {
      useClass: T2QPromptGenerator,
    });

    container.register<string>("log.directory", {
      useValue: this.config.log?.directory ?? "log",
    });
    container.register<string>("log.level", {
      useValue: this.config.log?.level ?? "info",
    });
  }
}
