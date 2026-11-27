import { Router, type NextFunction, type Request, type Response } from "express";
import { ObjectId, type Db } from "mongodb";
import { createRequireSession } from "../auth/session-routes.ts";
import { emailTemplates, getSiteSettings, recordActivity, type EmailTemplate, type SiteSettings, type TemplateKey } from "./site-settings.ts";

type AuthUser = {
  _id: ObjectId; name: string; email: string; role?: string; accountType?: string; active?: boolean; emailVerified?: boolean;
};

export function createAdminRoutes(db: Db, frontendOrigin: string) {
  const router = Router();
  const requireSession = createRequireSession(frontendOrigin);
  const allowedOrigin = new URL(frontendOrigin).origin;
  const users = db.collection<AuthUser>("user");
  const templates = db.collection<EmailTemplate>("emailTemplates");
  const settings = db.collection<SiteSettings>("siteSettings");

  function requireAdmin(_request: Request, response: Response, next: NextFunction) {
    if (response.locals.currentUser.role !== "admin") {
      response.status(403).json({ message: "Only admins can access this section." });
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

  router.get("/site-settings", async (_request, response) => {
    const { contactEmail } = await getSiteSettings(db);
    response.json({ contactEmail });
  });

  router.get("/admin/settings", requireSession, requireAdmin, async (_request, response) => {
    response.json({ settings: await getSiteSettings(db) });
  });

  router.patch("/admin/settings", requireMutation, requireSession, requireAdmin, async (request, response) => {
    const { featuredDays } = request.body ?? {};
    const contactEmail = typeof request.body?.contactEmail === "string" ? request.body.contactEmail.trim() : "";
    if (contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)
      || !Number.isInteger(featuredDays) || featuredDays < 1 || featuredDays > 30) {
      response.status(400).json({ message: "Enter a contact email and a Hot job duration between 1 and 30 days." });
      return;
    }
    await settings.updateOne({ _id: "site" }, { $set: { contactEmail, featuredDays } }, { upsert: true });
    await recordActivity(db, response.locals.currentUser.id, "Updated site settings", "site");
    response.json({ settings: { contactEmail, featuredDays } });
  });

  router.get("/admin/email-templates", requireSession, requireAdmin, async (_request, response) => {
    const saved = new Map((await templates.find().toArray()).map(({ _id, subject, text }) => [_id, { subject, text }]));
    response.json({ templates: Object.entries(emailTemplates).map(([key, original]) => ({ key, ...(saved.get(key as TemplateKey) ?? original) })) });
  });

  router.patch("/admin/email-templates/:key", requireMutation, requireSession, requireAdmin, async (request, response) => {
    const { key } = request.params;
    const { subject, text } = request.body ?? {};
    if (typeof key !== "string" || !Object.hasOwn(emailTemplates, key)
      || typeof subject !== "string" || !subject.trim() || subject.length > 160 || /[\r\n]/.test(subject)
      || typeof text !== "string" || !text.trim() || text.length > 4000) {
      response.status(400).json({ message: "Enter a valid subject and email message." });
      return;
    }
    await templates.updateOne({ _id: key as TemplateKey }, { $set: { subject: subject.trim(), text: text.trim() } }, { upsert: true });
    await recordActivity(db, response.locals.currentUser.id, "Updated email template", key);
    response.json({ message: "Template saved." });
  });

  router.get("/admin/users", requireSession, requireAdmin, async (_request, response) => {
    const accounts = await users.find().project({ name: 1, email: 1, role: 1, accountType: 1, active: 1, emailVerified: 1 }).sort({ _id: -1 }).limit(200).toArray();
    response.json({ users: accounts });
  });

  router.patch("/admin/users/:id", requireMutation, requireSession, requireAdmin, async (request, response) => {
    const { id } = request.params;
    const { active } = request.body ?? {};
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id) || typeof active !== "boolean") {
      response.status(400).json({ message: "Choose a valid account and status." });
      return;
    }
    const result = await users.updateOne({ _id: new ObjectId(id), role: { $ne: "admin" } }, { $set: { active } });
    if (!result.matchedCount) {
      response.status(404).json({ message: "This account cannot be changed here." });
      return;
    }
    await recordActivity(db, response.locals.currentUser.id, active ? "Reactivated user" : "Disabled user", id);
    response.json({ message: "Account status updated." });
  });

  router.get("/admin/activity", requireSession, requireAdmin, async (_request, response) => {
    const activity = await db.collection("activityLog").find().sort({ createdAt: -1 }).limit(100).toArray();
    response.json({ activity });
  });

  return router;
}
