import { Router, type NextFunction, type Request, type Response } from "express";
import { ObjectId, type Db } from "mongodb";
import { createRequireSession } from "../auth/session-routes.ts";
import { todayInTheUK, type Job } from "../jobs/job-routes.ts";
import { escapeSearch } from "../categories/category-routes.ts";
import type { CompanyApplication } from "./company-routes.ts";
import { companyLogoIds } from "./company-logos.ts";
import { publicCompanyId } from "./public-companies.ts";

type JobView = { _id: string; ownerId: string; jobId: string; day: string; count: number };
type EmployerSettings = { _id: string; notificationsReadAt?: string; showNotificationBadge?: boolean };
type ApplicationSummary = {
  _id: string; companyOwnerId: string; status: string; name: string; jobId: string;
  jobTitle: string; createdAt: Date; forwardedAt?: Date;
  employerStatus?: "reviewed" | "shortlisted" | "not-suitable";
};

const ukDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });

function daysEndingToday(count: number) {
  const end = Date.parse(`${todayInTheUK()}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(end - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));
}

export function createEmployerDashboardRoutes(db: Db, frontendOrigin: string) {
  const router = Router();
  const jobs = db.collection<Job>("jobs");
  const companies = db.collection<CompanyApplication>("companyApplications");
  const applications = db.collection<ApplicationSummary>("jobApplications");
  const views = db.collection<JobView>("jobViews");
  const settings = db.collection<EmployerSettings>("employerSettings");
  const requireSession = createRequireSession(frontendOrigin);
  const origin = new URL(frontendOrigin).origin;
  const viewBudget = new Map<string, { expires: number; remaining: number }>();

  function requireOrigin(request: Request, response: Response, next: NextFunction) {
    if (request.get("Origin") !== origin || !request.is("application/json")) {
      response.status(403).json({ message: "Submit this request from the job board." });
      return;
    }
    next();
  }

  function requireEmployer(_request: Request, response: Response, next: NextFunction) {
    if (response.locals.currentUser.role !== "employer") {
      response.status(403).json({ message: "Sign in to the employer dashboard." });
      return;
    }
    next();
  }

  router.post("/jobs/:id/view", requireOrigin, async (request, response) => {
    const { id } = request.params;
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) {
      response.sendStatus(404);
      return;
    }
    const now = Date.now();
    if (viewBudget.size >= 1000) {
      for (const [key, value] of viewBudget) if (value.expires <= now) viewBudget.delete(key);
    }
    const key = request.ip ?? "local";
    const budget = viewBudget.get(key);
    if ((budget && budget.expires > now && budget.remaining <= 0) || (!budget && viewBudget.size >= 1000)) {
      response.sendStatus(429);
      return;
    }
    viewBudget.set(key, budget && budget.expires > now ? { ...budget, remaining: budget.remaining - 1 } : { expires: now + 60_000, remaining: 59 });
    const job = await jobs.findOne({ _id: new ObjectId(id), status: "live", closingDate: { $gte: todayInTheUK() } }, { projection: { ownerId: 1 } });
    if (!job || await companies.findOne({ _id: job.ownerId, status: "suspended" }, { projection: { _id: 1 } })) {
      response.sendStatus(404);
      return;
    }
    const day = todayInTheUK();
    const jobId = job._id.toHexString();
    await views.updateOne({ _id: `${jobId}:${day}` }, {
      $setOnInsert: { jobId, day, ownerId: job.ownerId }, $inc: { count: 1 },
    }, { upsert: true });
    response.sendStatus(204);
  });

  router.get("/employer/dashboard", requireSession, requireEmployer, async (request, response) => {
    const ownerId = response.locals.currentUser.id;
    const count = request.query.days === "7" ? 7 : request.query.days === "90" ? 90 : 30;
    const dates = daysEndingToday(count);
    const [company, preferences] = await Promise.all([
      companies.findOne({ _id: ownerId }, { projection: { "details.name": 1, status: 1, reviewedAt: 1, rejectionReason: 1 } }),
      settings.findOne({ _id: ownerId }),
    ]);
    const companyId = publicCompanyId(ownerId);
    const logos = company?.status === "approved" ? await companyLogoIds(db, [companyId]) : new Set<string>();
    const companyInfo = company ? { name: company.details.name, status: company.status, rejectionReason: company.rejectionReason,
      logoUrl: logos.has(companyId) ? `/company-logo/${companyId}` : undefined } : null;
    const notifications: { id: string; title: string; detail: string; date: Date; href: string }[] = company?.reviewedAt ? [{
      id: "company-review", title: company.status === "approved" ? "Company approved" : "Company review updated",
      detail: company.rejectionReason || company.details.name, date: company.reviewedAt, href: "/dashboard/employer/company",
    }] : [];
    const empty = {
      company: companyInfo, stats: { jobs: 0, applications: 0, hot: 0, views: 0 }, jobs: [], applications: [],
      series: dates.map((date) => ({ date, views: 0, applications: 0 })), notifications,
      preferences: { showNotificationBadge: preferences?.showNotificationBadge ?? true, notificationsReadAt: preferences?.notificationsReadAt },
    };
    if (company?.status !== "approved") { response.json(empty); return; }

    const today = todayInTheUK();
    const now = new Date();
    const firstDay = new Date(`${dates[0]}T00:00:00Z`);
    // Include the UTC hour around midnight in summer; bucket and trim by UK date below.
    const threshold = new Date(firstDay.getTime() - 3_600_000);
    const forwarded = { companyOwnerId: ownerId, status: "forwarded" };
    const [jobCount, hotCount, applicationCount, recentJobs, recentApplications, viewStats, appDates] = await Promise.all([
      jobs.countDocuments({ ownerId }),
      jobs.countDocuments({ ownerId, status: "live", closingDate: { $gte: today }, featuredUntil: { $gt: now } }),
      applications.countDocuments(forwarded),
      jobs.find({ ownerId }).project({ title: 1, location: 1, jobType: 1, status: 1, closingDate: 1, createdAt: 1, publishedAt: 1 }).sort({ createdAt: -1 }).limit(5).toArray(),
      applications.find(forwarded).project<ApplicationSummary>({ name: 1, jobTitle: 1, jobId: 1, status: 1, employerStatus: 1, createdAt: 1, forwardedAt: 1 }).sort({ forwardedAt: -1 }).limit(20).toArray(),
      views.aggregate<{ total: { count: number }[]; daily: { _id: string; count: number }[] }>([
        { $match: { ownerId } },
        { $facet: {
          total: [{ $group: { _id: null, count: { $sum: "$count" } } }],
          daily: [{ $match: { day: { $gte: dates[0] } } }, { $group: { _id: "$day", count: { $sum: "$count" } } }],
        } },
      ]).next(),
      applications.find({ ...forwarded, forwardedAt: { $gte: threshold } }).project({ forwardedAt: 1 }).toArray(),
    ]);
    const viewsByDay = new Map(viewStats?.daily.map(({ _id, count }) => [_id, count]) ?? []);
    const appsByDay = new Map<string, number>();
    for (const entry of appDates) {
      if (!entry.forwardedAt) continue;
      const day = ukDay.format(entry.forwardedAt);
      appsByDay.set(day, (appsByDay.get(day) ?? 0) + 1);
    }
    notifications.push(...recentApplications.flatMap((entry) => entry.forwardedAt ? [{
      id: entry._id, title: "Application forwarded", detail: `${entry.name} · ${entry.jobTitle}`, date: entry.forwardedAt,
      href: "/dashboard/employer/applications",
    }] : []));
    response.json({
      ...empty,
      stats: { jobs: jobCount, applications: applicationCount, hot: hotCount, views: viewStats?.total[0]?.count ?? 0 },
      jobs: recentJobs,
      applications: recentApplications.slice(0, 5),
      series: dates.map((date) => ({ date, views: viewsByDay.get(date) ?? 0, applications: appsByDay.get(date) ?? 0 })),
      notifications: notifications.sort((a, b) => b.date.getTime() - a.date.getTime()),
    });
  });

  router.patch("/employer/settings", requireOrigin, requireSession, requireEmployer, async (request, response) => {
    const { showNotificationBadge, notificationsReadAt } = request.body ?? {};
    const ownerId = response.locals.currentUser.id;
    if (typeof showNotificationBadge === "boolean") {
      await settings.updateOne({ _id: ownerId }, { $set: { showNotificationBadge } }, { upsert: true });
    } else {
      const timestamp = typeof notificationsReadAt === "string" ? Date.parse(notificationsReadAt) : NaN;
      if (!Number.isFinite(timestamp) || timestamp > Date.now()) {
        response.status(400).json({ message: "Refresh the dashboard and try again." });
        return;
      }
      await settings.updateOne({ _id: ownerId }, { $max: { notificationsReadAt: new Date(timestamp).toISOString() } }, { upsert: true });
    }
    response.json({ message: "Dashboard preferences saved." });
  });

  router.get("/employer/search", requireSession, requireEmployer, async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 120) : "";
    const ownerId = response.locals.currentUser.id;
    if (!query || !await companies.findOne({ _id: ownerId, status: "approved" }, { projection: { _id: 1 } })) {
      response.json({ jobs: [], applications: [] });
      return;
    }
    const match = { $regex: escapeSearch(query), $options: "i" };
    const [foundJobs, foundApplications] = await Promise.all([
      jobs.find({ ownerId, $or: [{ title: match }, { location: match }] }).project({ title: 1, location: 1 }).limit(6).toArray(),
      applications.find({ companyOwnerId: ownerId, status: "forwarded", $or: [{ name: match }, { jobTitle: match }] })
        .project({ name: 1, jobTitle: 1 }).limit(6).toArray(),
    ]);
    response.json({ jobs: foundJobs, applications: foundApplications });
  });

  return router;
}
