import { cvUploadLimitMb } from "./src/cv-upload.ts";
import cors from "cors";
import { config } from "dotenv";
import express from "express";
import { MongoClient, MongoError } from "mongodb";
import { createSessionRoutes } from "./src/auth/session-routes.ts";
import { createCompanyRoutes } from "./src/companies/company-routes.ts";
import { createJobRoutes, todayInTheUK } from "./src/jobs/job-routes.ts";
import { createCategoryRoutes, getCategoryCollection } from "./src/categories/category-routes.ts";
import { createApplicationRoutes } from "./src/applications/application-routes.ts";
import { createPublicCompanyRoutes } from "./src/companies/public-companies.ts";
import { createCompanyLogoRoutes } from "./src/companies/company-logos.ts";
import { createAdminRoutes } from "./src/admin/admin-routes.ts";
import { createSeekerProfileRoutes } from "./src/auth/seeker-profile-routes.ts";
import { createEmployerDashboardRoutes } from "./src/companies/employer-dashboard-routes.ts";

config({ quiet: true });

const app = express();
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "localhost");
const port = Number(process.env.PORT ?? 5000);
const frontendOrigin = new URL(process.env.FRONTEND_ORIGIN || "http://localhost:3000").origin;

app.use(cors({ origin: frontendOrigin, credentials: true }));
const parseJson = express.json();
app.use((request, response, next) => {
  // CV requests are parsed after their session and origin have been checked.
  if ((request.method === "POST" && /^\/api\/job-applications\/?$/i.test(request.path))
    || (request.method === "PUT" && /^\/api\/(?:company-logo|seeker\/cv)\/?$/i.test(request.path))
    || (request.method === "PATCH" && /^\/api\/(?:seeker|employer|admin)\/profile\/?$/i.test(request.path))) {
    next();
    return;
  }
  parseJson(request, response, next);
});
app.use("/api", createSessionRoutes(frontendOrigin));

app.get(["/", "/health"], (_request, response) => {
  response.json({ status: "ok" });
});

export async function connectToMongoDB() {
  const uri = process.env.MONGODB_URI?.trim();

  if (!uri) {
    throw new Error("Set MONGODB_URI in the backend .env file.");
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });

  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    return client;
  } catch (error) {
    await client.close();
    const reason = error instanceof MongoError
      ? error.code ?? error.name
      : error instanceof Error ? error.name : "unknown error";
    throw new Error(`MongoDB connection failed (${reason}). Check the URI, database credentials, and network access.`);
  }
}

async function createDatabaseRoutes() {
  const client = await connectToMongoDB();
  console.log("Connected to MongoDB.");
  const db = client.db("UkJobBoardDB");
  try {
    await getCategoryCollection(db).createIndex({ nameKeys: 1 }, { unique: true });
  } catch {
    await client.close();
    throw new Error("Could not prepare the MongoDB categories collection.");
  }
  const router = express.Router();
  router.use(createCompanyRoutes(db, frontendOrigin), createJobRoutes(db, frontendOrigin), createApplicationRoutes(db, frontendOrigin), createCategoryRoutes(db, frontendOrigin, todayInTheUK));
  router.use(createPublicCompanyRoutes(db, todayInTheUK));
  router.use(createCompanyLogoRoutes(db, frontendOrigin));
  router.use(createAdminRoutes(db, frontendOrigin));
  router.use(createSeekerProfileRoutes(db, frontendOrigin));
  router.use(createEmployerDashboardRoutes(db, frontendOrigin));
  return router;
}

let databaseRoutes: ReturnType<typeof createDatabaseRoutes> | undefined;

function getDatabaseRoutes() {
  // Concurrent requests share one MongoDB connection per instance.
  databaseRoutes ??= createDatabaseRoutes().catch((error) => {
    databaseRoutes = undefined;
    throw error;
  });
  return databaseRoutes;
}

app.use("/api", async (request, response, next) => {
  const router = await getDatabaseRoutes();
  router(request, response, next);
});

app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof Error && "status" in error && error.status === 413) {
    const uploadMessage = request.path === "/api/company-logo" ? "Upload a logo up to 2 MB."
      : /^\/api\/(?:seeker|employer|admin)\/profile\/?$/i.test(request.path) ? "Upload a profile image up to 1 MB."
      : `Your CV is too large. Upload a file up to ${cvUploadLimitMb} MB.`;
    response.status(413).json({ message: uploadMessage });
    return;
  }
  if (error instanceof SyntaxError && "status" in error && error.status === 400) {
    response.status(400).json({ message: "Send a valid JSON request." });
    return;
  }
  response.status(500).json({ message: "Something went wrong. Try again shortly." });
});

async function startServer() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a number between 1 and 65535.");
  }

  await getDatabaseRoutes();

  app.listen(port, host, (error) => {
    if (error) {
      const reason = "code" in error ? error.code : error.name;
      console.error(`Could not start the backend on port ${port} (${reason}).`);
      process.exitCode = 1;
      return;
    }

    console.log(`Backend running at http://${host}:${port}`);
  });
}

if (process.env.VERCEL !== "1") {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not start the backend.");
    process.exitCode = 1;
  });
}

export default app;
