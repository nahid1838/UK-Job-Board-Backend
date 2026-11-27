import { Router, type NextFunction, type Request, type Response } from "express";
import { ObjectId, type Db } from "mongodb";
import { createRequireSession } from "../auth/session-routes.ts";
import { emailTemplates, getSiteSettings, recordActivity, type EmailTemplate, type SiteSettings, type TemplateKey } from "./site-settings.ts";
import { todayInTheUK, type Job } from "../jobs/job-routes.ts";
import { escapeSearch } from "../categories/category-routes.ts";
import type { CompanyApplication } from "../companies/company-routes.ts";

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
  const companies = db.collection("companyApplications");
  const jobs = db.collection<Job>("jobs");
  const applications = db.collection("jobApplications");
  const activity = db.collection("activityLog");
  const preferences = db.collection<{ _id: string; readAt?: string }>("adminPreferences");

  router.get("/admin/dashboard", requireSession, requireAdmin, async (request, response) => {
    const days = request.query.days === "7" ? 7 : request.query.days === "90" ? 90 : 30;
    const today = todayInTheUK();
    const end = Date.parse(`${today}T00:00:00Z`);
    const dates = Array.from({ length: days }, (_, index) => new Date(end - (days - index - 1) * 86_400_000).toISOString().slice(0, 10));
    const threshold = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - 3_600_000);
    const suspended = await db.collection<CompanyApplication>("companyApplications").find({ status: "suspended" }).project({ _id: 1 }).toArray();
    const countDaily = () => [
      { $match: { createdAt: { $gte: threshold } } },
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: "Europe/London" } }, count: { $sum: 1 } } },
    ];
    const [jobCount, userCount, applicationCount, featured, statuses, recentApplications, recentActivities, views, dailyApps, dailyUsers, dailyJobs, dailyApprovals, dailyFeatured, preference, pendingApplications] = await Promise.all([
      jobs.countDocuments(), users.countDocuments(), applications.countDocuments(),
      jobs.countDocuments({ status: "live", closingDate: { $gte: today }, featuredUntil: { $gt: new Date() },
        ...(suspended.length && { ownerId: { $nin: suspended.map(({ _id }) => _id) } }) }),
      companies.aggregate<{ _id: string; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
      applications.find().project({ name: 1, jobTitle: 1, companyName: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(5).toArray(),
      activity.find().project({ action: 1, target: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(12).toArray(),
      db.collection("jobViews").aggregate<{ _id: string; count: number }>([{ $match: { day: { $gte: dates[0] } } }, { $group: { _id: "$day", count: { $sum: "$count" } } }]).toArray(),
      applications.aggregate<{ _id: string; count: number }>(countDaily()).toArray(),
      users.aggregate<{ _id: string; count: number }>(countDaily()).toArray(),
      jobs.aggregate<{ _id: string; count: number }>(countDaily()).toArray(),
      activity.aggregate<{ _id: string; count: number }>([{ $match: { action: { $in: ["Company approved", "Company reactivated"] } } }, ...countDaily()]).toArray(),
      activity.aggregate<{ _id: string; count: number }>([{ $match: { action: "Job featured" } }, ...countDaily()]).toArray(),
      preferences.findOne({ _id: response.locals.currentUser.id }),
      applications.countDocuments({ status: "new" }),
    ]);
    const companyCounts = Object.fromEntries(statuses.map(({ _id, count }) => [_id, count]));
    const byDay = (data: { _id: string; count: number }[]) => new Map(data.map(({ _id, count }) => [_id, count]));
    const [viewMap, appMap, userMap, jobMap, companyMap, featuredMap] = [views, dailyApps, dailyUsers, dailyJobs, dailyApprovals, dailyFeatured].map(byDay);
    response.json({
      stats: { jobs: jobCount, companies: companyCounts.approved ?? 0, users: userCount, applications: applicationCount, featured },
      companies: Object.fromEntries(["approved", "pending", "rejected", "suspended"].map((status) => [status, companyCounts[status] ?? 0])),
      pendingApplications, recentApplications, recentActivities, readAt: preference?.readAt,
      series: dates.map((date) => ({ date, views: viewMap.get(date) ?? 0, applications: appMap.get(date) ?? 0, users: userMap.get(date) ?? 0,
        jobs: jobMap.get(date) ?? 0, companies: companyMap.get(date) ?? 0, featured: featuredMap.get(date) ?? 0 })),
    });
  });

  router.get("/admin/search", requireSession, requireAdmin, async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 120) : "";
    if (!query) { response.json({ results: [] }); return; }
    const match = { $regex: escapeSearch(query), $options: "i" };
    const [foundCompanies, foundJobs, foundUsers] = await Promise.all([
      companies.find({ "details.name": match }).project({ "details.name": 1 }).limit(5).toArray(),
      jobs.find({ title: match }).project({ title: 1 }).limit(5).toArray(),
      users.find({ $or: [{ name: match }, { email: match }] }).project({ name: 1 }).limit(5).toArray(),
    ]);
    response.json({ results: [
      ...foundCompanies.map((item) => ({ id: String(item._id), title: item.details.name as string, section: "companies" })),
      ...foundJobs.map((item) => ({ id: String(item._id), title: item.title as string, section: "jobs" })),
      ...foundUsers.map((item) => ({ id: String(item._id), title: item.name as string, section: "users" })),
    ] });
  });

  router.patch("/admin/notifications", requireMutation, requireSession, requireAdmin, async (request, response) => {
    const through = typeof request.body?.through === "string" ? Date.parse(request.body.through) : NaN;
    if (!Number.isFinite(through) || through > Date.now()) { response.status(400).json({ message: "Refresh your notifications and try again." }); return; }
    await preferences.updateOne({ _id: response.locals.currentUser.id }, { $max: { readAt: new Date(through).toISOString() } }, { upsert: true });
    response.json({ message: "Notifications marked as read." });
  });

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

  router.patch("/admin/users/:id/role", requireMutation, requireSession, requireAdmin, async (request, response) => {
    const { id } = request.params;
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id) || request.body?.role !== "admin") {
      response.status(400).json({ message: "Choose a valid account to promote to admin." });
      return;
    }

    const userId = new ObjectId(id);
    const result = await users.updateOne(
      { _id: userId, role: { $ne: "admin" }, active: { $ne: false } },
      { $set: { role: "admin" } },
    );
    if (result.modifiedCount) {
      await recordActivity(db, response.locals.currentUser.id, "Promoted user to admin", id);
    } else {
      const user = await users.findOne({ _id: userId });
      if (!user) {
        response.status(404).json({ message: "This account could not be found." });
        return;
      }
      if (user.role !== "admin") {
        response.status(409).json({ message: "Reactivate this account before granting admin access." });
        return;
      }
    }

    response.json({ role: "admin" });
  });

  router.get("/admin/activity", requireSession, requireAdmin, async (_request, response) => {
    const activity = await db.collection("activityLog").find().sort({ createdAt: -1 }).limit(100).toArray();
    response.json({ activity });
  });

  return router;
}
