import "reflect-metadata";

import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");

import summarizeRoute from "./routes/query2text";
import generateRoute from "./routes/text2query";
import reconciliationRoute from "./routes/reconcile";
import home from "./routes/home";
import sparqlRouter from "./routes/sparql";
import pingRoute from "./routes/ping";
import promptT2QRoute from "./routes/t2qPrompt";
import promptQ2TRoute from "./routes/q2tPrompt";

import { checkDomainMiddleware } from "./middleware/checkDomainMiddleware";

import { warmUpLunrIndexes } from "kgcompass";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Swagger doc
const swaggerDocument = YAML.load(path.join(__dirname, "../docs/openapi.yaml"));

// CORS
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: false,
};

// Logs généraux
/*
app.use((req, res, next) => {
  console.log(`🔍 ${req.method} ${req.originalUrl}`);
  next();
});
*/
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Routes sécurisées
app.use(
  "/api/v1/:projectKey/query2text",
  checkDomainMiddleware,
  summarizeRoute,
);
app.use("/api/v1/:projectKey/text2query", generateRoute);

app.use(
  "/api/v1/:projectKey/reconciliation",
  (req, res, next) => {
    console.log(
      `🔍 reconciliation request - ProjectKey: ${req.params.projectKey}`,
    );
    console.log(`📝 Method: ${req.method}`);
    console.log(`📊 Query params:`, req.query);
    console.log(`📦 Body:`, req.body);
    console.log(`📋 Headers:`, req.headers);
    next();
  },
  reconciliationRoute,
);
// sparql endpoint
app.use("/api/v1/:projectKey/sparql", sparqlRouter);

// ping route
app.use("/api/v1/:projectKey/ping", pingRoute);

// prompt t2q route

app.use(
  "/api/v1/:projectKey/prompt-t2q",
  checkDomainMiddleware,
  promptT2QRoute,
);

app.use(
  "/api/v1/:projectKey/prompt-q2t",
  checkDomainMiddleware,
  promptQ2TRoute,
);

// Swagger
app.use("/api/v1", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
//app.use("/api/monitoring", monitoringStatsRoute);

// Acceuil de la plateforme
app.use("/", home);

app.use((req, res) => {
  res.status(404).json({ error: "Route not found", url: req.originalUrl });
});

// === Vérification de la clé Mistral avant lancement ===
if (!process.env.MISTRAL_API_KEY) {
  console.error("❌ Erreur critique : MISTRAL_API_KEY non définie.");
  process.exit(1); // Arrêt immédiat du serveur
}

// === Démarrage du serveur ===
app.listen(PORT, () => {
  console.log(`✅ Sparnatural service API listening on port ${PORT}`);

  // Pre-warm Lunr indexes for all projects that use LunrReconcileService (direct or chained).
  // Until they are ready, a reconciliation call waits for its index.
  warmUpLunrIndexes();
});
