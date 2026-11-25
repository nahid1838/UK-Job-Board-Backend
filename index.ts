import cors from "cors";
import { config } from "dotenv";
import express from "express";
import { MongoClient, MongoError } from "mongodb";
import { createSessionRoutes } from "./src/auth/session-routes.ts";

config({ quiet: true });

const app = express();
const host = "localhost";
const port = Number(process.env.PORT ?? 5000);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

app.use(cors({ origin: frontendOrigin, credentials: true }));
app.use(express.json());
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

async function startServer() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a number between 1 and 65535.");
  }

  const client = await connectToMongoDB();
  console.log("Connected to MongoDB.");

  app.listen(port, host, async (error) => {
    if (error) {
      await client.close();
      const reason = "code" in error ? error.code : error.name;
      console.error(`Could not start the backend on port ${port} (${reason}).`);
      process.exitCode = 1;
      return;
    }

    console.log(`Backend running at http://${host}:${port}`);
  });
}

startServer().catch((error) => {
  console.error(error instanceof Error ? error.message : "Could not start the backend.");
  process.exitCode = 1;
});
