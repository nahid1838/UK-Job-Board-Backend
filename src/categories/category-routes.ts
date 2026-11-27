import { Router, type NextFunction, type Request, type Response } from "express";
import { MongoServerError, ObjectId, type Db } from "mongodb";
import { createRequireSession } from "../auth/session-routes.ts";
import type { CompanyApplication } from "../companies/company-routes.ts";
import { recordActivity } from "../admin/site-settings.ts";

export type Category = {
  _id: ObjectId;
  name: string;
  nameKeys: string[];
  order: number;
  active: boolean;
};

export function getCategoryCollection(db: Db) {
  return db.collection<Category>("categories");
}

export async function findActiveCategory(db: Db, id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) return null;
  return getCategoryCollection(db).findOne({ _id: new ObjectId(id), active: true });
}

export function escapeSearch(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function categoryJobFilter(category: Category) {
  return {
    $or: [
      { categoryId: category._id.toHexString() },
      // Older jobs stored only a category label. Keep matching it after a rename.
      { categoryId: { $exists: false }, category: { $in: category.nameKeys.map((key) => new RegExp(`^${escapeSearch(key)}$`, "i")) } },
    ],
  };
}

function readCategory(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100 || typeof body.active !== "boolean"
    || typeof body.order !== "number" || !Number.isInteger(body.order) || body.order < 0 || body.order > 9999) {
    return null;
  }
  return { name, active: body.active, order: body.order };
}

export function createCategoryRoutes(db: Db, frontendOrigin: string, todayInTheUK: () => string) {
  const router = Router();
  const categories = getCategoryCollection(db);
  const jobs = db.collection("jobs");
  const requireSession = createRequireSession(frontendOrigin);
  const allowedOrigin = new URL(frontendOrigin).origin;
  const publicFields = { name: 1, active: 1, order: 1 } as const;
  const sort = { order: 1, name: 1 } as const;

  function requireAdmin(_request: Request, response: Response, next: NextFunction) {
    if (response.locals.currentUser.role !== "admin") {
      response.status(403).json({ message: "Only admins can manage categories." });
      return;
    }
    next();
  }

  function requireMutation(request: Request, response: Response, next: NextFunction) {
    if (request.get("Origin") !== allowedOrigin || !request.is("application/json")) {
      response.status(403).json({ message: "Submit this request from the job board." });
      return;
    }
    next();
  }

  router.get("/categories", async (request, response) => {
    const active = await categories.find({ active: true }).sort(sort).toArray();
    const today = todayInTheUK();
    const suspended = request.query.counts === "true"
      ? await db.collection<CompanyApplication>("companyApplications").find({ status: "suspended" }).project({ _id: 1 }).toArray()
      : [];
    const results = await Promise.all(active.map(async ({ _id, name, active, order, nameKeys }) => ({
      _id, name, order,
      ...(request.query.counts === "true" ? {
        jobCount: await jobs.countDocuments({ status: "live", closingDate: { $gte: today },
          ...(suspended.length && { ownerId: { $nin: suspended.map(({ _id }) => _id) } }),
          ...categoryJobFilter({ _id, name, order, active, nameKeys }) }),
      } : {}),
    })));
    response.json({ categories: results });
  });

  router.get("/admin/categories", requireSession, requireAdmin, async (_request, response) => {
    response.json({ categories: await categories.find().project(publicFields).sort(sort).toArray() });
  });

  router.post("/admin/categories", requireMutation, requireSession, requireAdmin, async (request, response) => {
    const details = readCategory(request.body ?? {});
    if (!details) {
      response.status(400).json({ message: "Enter a category name and a display order from 0 to 9999." });
      return;
    }
    try {
      const _id = new ObjectId();
      await categories.insertOne({ _id, ...details, nameKeys: [details.name.toLowerCase()] });
      await recordActivity(db, response.locals.currentUser.id, "Category added", details.name);
      response.status(201).json({ category: { _id, ...details } });
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      response.status(409).json({ message: "That name is already in use by a category, including past names." });
    }
  });

  router.patch("/admin/categories/:id", requireMutation, requireSession, requireAdmin, async (request, response) => {
    const { id } = request.params;
    const details = readCategory(request.body ?? {});
    if (!details || typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) {
      response.status(400).json({ message: "Enter a valid category name and display order." });
      return;
    }
    try {
      const category = await categories.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: details, $addToSet: { nameKeys: details.name.toLowerCase() } },
        { returnDocument: "after", projection: publicFields },
      );
      if (!category) {
        response.status(404).json({ message: "Category not found." });
        return;
      }
      await recordActivity(db, response.locals.currentUser.id, "Category updated", details.name);
      response.json({ category });
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      response.status(409).json({ message: "That name is already in use by a category, including past names." });
    }
  });

  return router;
}
