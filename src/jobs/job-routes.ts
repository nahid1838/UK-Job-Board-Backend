import { Router, type NextFunction, type Request, type Response } from "express";
import { ObjectId, type Db, type Filter, type Sort } from "mongodb";
import { publicCompanyId } from "../companies/public-companies.ts";
import { companyLogoIds } from "../companies/company-logos.ts";
import { createRequireSession } from "../auth/session-routes.ts";
import type { CompanyApplication } from "../companies/company-routes.ts";
import { categoryJobFilter, escapeSearch, findActiveCategory } from "../categories/category-routes.ts";

const fieldLimits = {
  title: 120, category: 100, description: 6000, location: 120, postcode: 10,
  jobType: 30, workMode: 20, experience: 30, closingDate: 10,
} as const;

type JobDetails = Record<keyof typeof fieldLimits, string> & {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPeriod: string;
  rightToWork: boolean;
};

export type Job = JobDetails & {
  categoryId?: string;
  ownerId: string;
  companyName: string;
  status: "draft" | "live" | "closed";
  createdAt: Date;
  publishedAt?: Date;
  featuredUntil?: Date;
};

export function todayInTheUK() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function readJobDetails(body: Record<string, unknown>): JobDetails {
  const details = Object.fromEntries(Object.entries(fieldLimits).map(([key, max]) => {
    const input = body[key];
    const value = typeof input === "string" ? input.trim() : "";
    if (!value || value.length > max) throw new Error("Complete all required job fields and check their lengths.");
    return [key, value];
  })) as Record<keyof typeof fieldLimits, string>;

  if (!["Full-time", "Part-time", "Contract", "Temporary", "Internship", "Apprenticeship"].includes(details.jobType)
    || !["On-site", "Hybrid", "Remote"].includes(details.workMode)
    || !["Entry", "Mid", "Senior", "Lead", "Any level"].includes(details.experience)) {
    throw new Error("Choose a valid job type, work mode, and experience level.");
  }
  if (!/^(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i.test(details.postcode)) {
    throw new Error("Enter a valid UK postcode.");
  }
  const closing = new Date(details.closingDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(details.closingDate) || Number.isNaN(closing.getTime())
    || closing.toISOString().slice(0, 10) !== details.closingDate || details.closingDate < todayInTheUK()) {
    throw new Error("Enter a valid closing date that is today or later.");
  }
  const salaryMin = readSalary(body.salaryMin);
  const salaryMax = readSalary(body.salaryMax);
  if (salaryMin !== null && salaryMax !== null && salaryMax < salaryMin) {
    throw new Error("Maximum salary must be at least the minimum salary.");
  }
  const salaryPeriod = typeof body.salaryPeriod === "string" ? body.salaryPeriod : "";
  const hasSalary = salaryMin !== null || salaryMax !== null;
  if (hasSalary && !["year", "month", "day", "hour"].includes(salaryPeriod)) {
    throw new Error("Choose the pay period for the advertised salary.");
  }
  return { ...details, salaryMin, salaryMax, salaryPeriod: hasSalary ? salaryPeriod : "", rightToWork: body.rightToWork === true };
}

function readSalary(input: unknown) {
  if (input === "" || input === undefined || input === null) return null;
  if (typeof input !== "string" || !/^\d{1,9}(?:\.\d{1,2})?$/.test(input)) {
    throw new Error("Enter a valid salary in GBP, or leave it blank.");
  }
  return Number(input);
}

export function createJobRoutes(db: Db, frontendOrigin: string) {
  const router = Router();
  const jobs = db.collection<Job>("jobs");
  const companies = db.collection<CompanyApplication>("companyApplications");
  const requireSession = createRequireSession(frontendOrigin);
  const allowedOrigin = new URL(frontendOrigin).origin;

  async function requireApprovedCompany(_request: Request, response: Response, next: NextFunction) {
    const user = response.locals.currentUser;
    const company = user.role === "admin" ? null : await companies.findOne({ _id: user.id, status: "approved" });
    if (!company) {
      response.status(403).json({ message: "Your company must be approved before you can manage jobs." });
      return;
    }
    response.locals.approvedCompany = company;
    next();
  }

  function requireJsonMutation(request: Request, response: Response, next: NextFunction) {
    if (request.get("Origin") !== allowedOrigin || !request.is("application/json")) {
      response.status(403).json({ message: "Submit this request from the job board." });
      return;
    }
    next();
  }

  function requireAdmin(_request: Request, response: Response, next: NextFunction) {
    if (response.locals.currentUser.role !== "admin") {
      response.status(403).json({ message: "Only admins can moderate jobs." });
      return;
    }
    next();
  }

  router.get("/employer/jobs", requireSession, requireApprovedCompany, async (_request, response) => {
    const ownedJobs = await jobs.find({ ownerId: response.locals.currentUser.id }).sort({ createdAt: -1 }).toArray();
    response.json({ jobs: ownedJobs });
  });

  router.post("/employer/jobs", requireJsonMutation, requireSession, requireApprovedCompany, async (request, response) => {
    const category = await findActiveCategory(db, request.body?.categoryId);
    if (!category) {
      response.status(400).json({ message: "Choose an active job category." });
      return;
    }
    let details;
    try {
      details = readJobDetails({ ...request.body, category: category.name });
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Check the job details." });
      return;
    }
    const job: Job = {
      ...details,
      categoryId: category._id.toHexString(),
      ownerId: response.locals.currentUser.id,
      companyName: response.locals.approvedCompany.details.name,
      status: "draft",
      createdAt: new Date(),
    };
    const { insertedId } = await jobs.insertOne(job);
    response.status(201).json({ job: { ...job, _id: insertedId } });
  });

  router.patch("/employer/jobs/:id/publish", requireJsonMutation, requireSession, requireApprovedCompany, async (request, response) => {
    const { id } = request.params;
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) {
      response.status(404).json({ message: "Job draft not found." });
      return;
    }
    const ownerId = response.locals.currentUser.id;
    const _id = new ObjectId(id);
    const job = await jobs.findOneAndUpdate(
      { _id, ownerId, status: "draft", closingDate: { $gte: todayInTheUK() } },
      { $set: { status: "live", publishedAt: new Date(), companyName: response.locals.approvedCompany.details.name } },
      { returnDocument: "after" },
    );
    if (!job) {
      response.status(409).json({ message: "This draft is unavailable or its closing date has passed." });
      return;
    }
    response.json({ job });
  });

  async function manageJob(request: Request, response: Response) {
    const { id } = request.params;
    const action = request.body?.action;
    const user = response.locals.currentUser;
    const isAdmin = user.role === "admin";
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) {
      response.status(404).json({ message: "Job not found." });
      return;
    }
    const filter = { _id: new ObjectId(id), ...(!isAdmin && { ownerId: user.id }) };
    const current = await jobs.findOne(filter);
    if (!current) {
      response.status(404).json({ message: "Job not found." });
      return;
    }
    if (action === "duplicate" && !isAdmin) {
      const { _id, featuredUntil, publishedAt, ...details } = current;
      const job: Job = { ...details, status: "draft", createdAt: new Date() };
      const result = await jobs.insertOne(job);
      response.status(201).json({ job: { ...job, _id: result.insertedId } });
      return;
    }
    let update: Partial<Job>;
    if (action === "edit") {
      const category = await findActiveCategory(db, request.body.categoryId);
      if (!category) {
        response.status(400).json({ message: "Choose an active category." });
        return;
      }
      try {
        update = { ...readJobDetails({ ...request.body, category: category.name }), categoryId: category._id.toHexString() };
      } catch (error) {
        response.status(400).json({ message: error instanceof Error ? error.message : "Check the job details." });
        return;
      }
    } else if (action === "close" && current.status === "live") {
      update = { status: "closed", featuredUntil: new Date(0) };
    } else if (action === "reopen" && !isAdmin && current.status === "closed" && current.closingDate >= todayInTheUK()) {
      update = { status: "live", publishedAt: new Date() };
    } else if (action === "feature" && current.status === "live" && current.closingDate >= todayInTheUK()) {
      if (typeof request.body.featured !== "boolean") {
        response.status(400).json({ message: "Choose whether to feature this job." });
        return;
      }
      update = { featuredUntil: request.body.featured ? new Date(Date.now() + 7 * 86_400_000) : new Date(0) };
    } else {
      response.status(409).json({ message: "This action is unavailable for the current job status." });
      return;
    }
    const job = await jobs.findOneAndUpdate({ ...filter, status: current.status }, { $set: update }, { returnDocument: "after" });
    if (!job) {
      response.status(409).json({ message: "This job changed. Refresh and try again." });
      return;
    }
    response.json({ job });
  }

  async function deleteJob(request: Request, response: Response) {
    const { id } = request.params;
    const user = response.locals.currentUser;
    const result = typeof id === "string" && /^[a-f0-9]{24}$/i.test(id)
      ? await jobs.deleteOne({ _id: new ObjectId(id), ...(user.role !== "admin" && { ownerId: user.id }) })
      : { deletedCount: 0 };
    if (!result.deletedCount) {
      response.status(404).json({ message: "Job not found." });
      return;
    }
    response.json({ message: "Job deleted." });
  }

  router.patch("/employer/jobs/:id", requireJsonMutation, requireSession, requireApprovedCompany, manageJob);
  router.delete("/employer/jobs/:id", requireJsonMutation, requireSession, requireApprovedCompany, deleteJob);
  router.get("/admin/jobs", requireSession, requireAdmin, async (_request, response) => {
    response.json({ jobs: await jobs.find().sort({ createdAt: -1 }).toArray() });
  });
  router.patch("/admin/jobs/:id", requireJsonMutation, requireSession, requireAdmin, manageJob);
  router.delete("/admin/jobs/:id", requireJsonMutation, requireSession, requireAdmin, deleteJob);

  router.get("/jobs", async (request, response) => {
    const search = (value: unknown) => typeof value === "string"
      ? escapeSearch(value.trim().slice(0, 120))
      : "";
    const keyword = search(request.query.keyword);
    const location = search(request.query.location);
    const categoryId = request.query.category;
    const category = categoryId ? await findActiveCategory(db, categoryId) : null;
    if (categoryId && !category) {
      response.json({ jobs: [] });
      return;
    }
    const filter: Filter<Job> = {
      status: "live", closingDate: { $gte: todayInTheUK() },
      ...(keyword && { $or: ["title", "description", "companyName", "location"].map((field) => ({ [field]: { $regex: keyword, $options: "i" } })) }),
      ...(location && { location: { $regex: location, $options: "i" } }),
      ...(category && { $and: [categoryJobFilter(category)] }),
    };
    const { jobType, workMode, company, posted, sort, salaryPeriod } = request.query;
    if (typeof jobType === "string" && jobType) filter.jobType = jobType.slice(0, 30);
    if (typeof workMode === "string" && workMode) filter.workMode = workMode.slice(0, 20);
    if (typeof company === "string" && company) filter.companyName = company.slice(0, 120);
    if (typeof posted === "string" && ["1", "7", "30"].includes(posted)) {
      filter.publishedAt = { $gte: new Date(Date.now() - Number(posted) * 86_400_000) };
    }
    const minSalary = typeof request.query.minSalary === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(request.query.minSalary) ? Number(request.query.minSalary) : null;
    const maxSalary = typeof request.query.maxSalary === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(request.query.maxSalary) ? Number(request.query.maxSalary) : null;
    const salaryFilters: Filter<Job>[] = [];
    if (minSalary !== null) salaryFilters.push({ $or: [{ salaryMax: { $gte: minSalary } }, { salaryMax: null, salaryMin: { $gte: minSalary } }] });
    if (maxSalary !== null) salaryFilters.push({ $or: [{ salaryMin: { $lte: maxSalary } }, { salaryMin: null, salaryMax: { $lte: maxSalary } }] });
    if (salaryFilters.length) filter.$and = [...(filter.$and ?? []), ...salaryFilters];
    if (salaryFilters.length || sort === "salary" || (typeof salaryPeriod === "string" && ["year", "month", "day", "hour"].includes(salaryPeriod))) {
      filter.salaryPeriod = typeof salaryPeriod === "string" && ["year", "month", "day", "hour"].includes(salaryPeriod) ? salaryPeriod : "year";
    }
    if (request.query.featured === "true") filter.featuredUntil = { $gt: new Date() };
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit), 10) || 100));
    const total = await jobs.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(pages, Math.max(1, Number.parseInt(String(request.query.page), 10) || 1));
    const order: Sort = sort === "closing" ? { closingDate: 1, publishedAt: -1, _id: -1 }
      : sort === "salary" ? { salaryMax: -1, salaryMin: -1, _id: -1 }
      : { publishedAt: -1, _id: -1 };
    const now = new Date();
    const results = (await jobs.aggregate<Job & { isFeatured: boolean }>([
      { $match: filter },
      { $set: { isFeatured: { $gt: [{ $ifNull: ["$featuredUntil", new Date(0)] }, now] } } },
      { $sort: request.query.prioritiseFeatured === "true" ? { isFeatured: -1, ...order } : order },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ]).toArray()).map(({ ownerId, ...job }) => ({ ...job, companyId: publicCompanyId(ownerId) }));
    const logoIds = await companyLogoIds(db, [...new Set(results.map(({ companyId }) => companyId))]);
    response.json({ jobs: results.map((job) => ({
      ...job, companyLogo: logoIds.has(job.companyId) ? `/company-logo/${job.companyId}` : undefined,
    })), total, pages, page });
  });

  router.get("/jobs/:id", async (request, response) => {
    const { id } = request.params;
    const job = typeof id === "string" && /^[a-f0-9]{24}$/i.test(id)
      ? await jobs.findOne({ _id: new ObjectId(id), status: "live", closingDate: { $gte: todayInTheUK() } })
      : null;
    if (!job) {
      response.status(404).json({ message: "This job is no longer accepting applications." });
      return;
    }
    const { ownerId, ...publicJob } = job;
    const companyId = publicCompanyId(ownerId);
    const logoIds = await companyLogoIds(db, [companyId]);
    response.json({ job: { ...publicJob, companyId,
      companyLogo: logoIds.has(companyId) ? `/company-logo/${companyId}` : undefined,
      isFeatured: Boolean(job.featuredUntil && job.featuredUntil > new Date()),
    } });
  });

  return router;
}
