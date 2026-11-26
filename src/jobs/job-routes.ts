import { Router, type NextFunction, type Request, type Response } from "express";
import { ObjectId, type Db } from "mongodb";
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
  status: "draft" | "live";
  createdAt: Date;
  publishedAt?: Date;
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
    const results = await jobs.find({
      status: "live", closingDate: { $gte: todayInTheUK() },
      ...(keyword && { $or: ["title", "description", "companyName"].map((field) => ({ [field]: { $regex: keyword, $options: "i" } })) }),
      ...(location && { location: { $regex: location, $options: "i" } }),
      ...(category && { $and: [categoryJobFilter(category)] }),
    }).project({ ownerId: 0 }).sort({ publishedAt: -1 }).limit(100).toArray();
    response.json({ jobs: results });
  });

  router.get("/jobs/:id", async (request, response) => {
    const { id } = request.params;
    const job = typeof id === "string" && /^[a-f0-9]{24}$/i.test(id)
      ? await jobs.findOne({ _id: new ObjectId(id), status: "live", closingDate: { $gte: todayInTheUK() } }, { projection: { ownerId: 0 } })
      : null;
    if (!job) {
      response.status(404).json({ message: "This job is no longer accepting applications." });
      return;
    }
    response.json({ job });
  });

  return router;
}
