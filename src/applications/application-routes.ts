import { json, Router, type Request, type Response, type NextFunction } from "express";
import { Binary, MongoServerError, ObjectId, type Db } from "mongodb";
import { createRequireSession } from "../auth/session-routes.ts";
import type { CompanyApplication } from "../companies/company-routes.ts";
import { todayInTheUK, type Job } from "../jobs/job-routes.ts";
import { publicCompanyId } from "../companies/public-companies.ts";
import { companyLogoIds } from "../companies/company-logos.ts";

const maxCvBytes = 5 * 1024 * 1024;
const cvTypes = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

type Application = {
  _id: string;
  jobId: string;
  jobTitle: string;
  companyName: string;
  companyOwnerId: string;
  seekerId: string;
  name: string;
  email: string;
  phone: string;
  coverLetter: string;
  cv: Binary;
  cvType: keyof typeof cvTypes;
  status: "new" | "shortlisted" | "forwarded" | "not-suitable";
  createdAt: Date;
  consentRecordedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  forwardedAt?: Date;
  forwardedBy?: string;
  employerStatus?: "reviewed" | "shortlisted" | "not-suitable";
};

const privateFields = { cv: 0, seekerId: 0, companyOwnerId: 0, reviewedBy: 0, forwardedBy: 0 } as const;
const seekerFields = { jobId: 1, jobTitle: 1, companyName: 1, companyOwnerId: 1, status: 1, createdAt: 1, reviewedAt: 1 } as const;

function readApplication(body: Record<string, unknown>, savedCv?: { cv: Binary; cvType: Application["cvType"] }) {
  const text = (key: string) => typeof body[key] === "string" ? body[key].trim() : "";
  const name = text("name");
  const email = text("email");
  const phone = text("phone");
  const coverLetter = text("coverLetter");
  if (!name || name.length > 120 || !phone || phone.length > 40 ||
    email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || coverLetter.length > 4000) {
    throw new Error("Check your name, email, phone number, and cover letter.");
  }
  if (body.acceptedConsent !== true) throw new Error("Confirm that your application can be shared after admin review.");
  if (body.useSavedCv === true) {
    if (!savedCv) throw new Error("Your saved CV is unavailable. Upload a CV to continue.");
    return { name, email, phone, coverLetter, cv: savedCv.cv, cvType: savedCv.cvType };
  }

  const encodedCv = body.cvBase64;
  if (typeof encodedCv !== "string" || !encodedCv || encodedCv.length > Math.ceil(maxCvBytes / 3) * 4) {
    throw new Error("Upload a PDF or DOCX CV up to 5 MB.");
  }
  const bytes = Buffer.from(encodedCv, "base64");
  if (bytes.length > maxCvBytes || bytes.toString("base64") !== encodedCv) {
    throw new Error("Upload a valid PDF or DOCX CV up to 5 MB.");
  }
  const isPdf = bytes.subarray(0, 5).toString() === "%PDF-";
  const isDocx = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    && bytes.includes(Buffer.from("[Content_Types].xml")) && bytes.includes(Buffer.from("word/document.xml"));
  if (!isPdf && !isDocx) throw new Error("The CV must be a PDF or DOCX file.");

  return { name, email, phone, coverLetter, cv: new Binary(bytes), cvType: isPdf ? "pdf" as const : "docx" as const };
}

export function createApplicationRoutes(db: Db, frontendOrigin: string) {
  const router = Router();
  const applications = db.collection<Application>("jobApplications");
  const jobs = db.collection<Job>("jobs");
  const companies = db.collection<CompanyApplication>("companyApplications");
  const profiles = db.collection<{ _id: string; cv: Binary; cvType: Application["cvType"] }>("seekerProfiles");
  const requireSession = createRequireSession(frontendOrigin);
  const allowedOrigin = new URL(frontendOrigin).origin;

  function requireMutation(request: Request, response: Response, next: NextFunction) {
    if (request.get("Origin") !== allowedOrigin || !request.is("application/json")) {
      response.status(403).json({ message: "Submit this request from the job board." });
      return;
    }
    next();
  }

  function requireAdmin(_request: Request, response: Response, next: NextFunction) {
    if (response.locals.currentUser.role !== "admin") {
      response.status(403).json({ message: "Only admins can review job applications." });
      return;
    }
    next();
  }

  router.post("/job-applications", requireMutation, requireSession, json({ limit: "7mb" }), async (request, response) => {
    const user = response.locals.currentUser;
    if (user.role !== "seeker") {
      response.status(403).json({ message: "Sign in as a job seeker to apply." });
      return;
    }
    const jobId = request.body?.jobId;
    if (typeof jobId !== "string" || !/^[a-f0-9]{24}$/i.test(jobId)) {
      response.status(404).json({ message: "This job is unavailable." });
      return;
    }
    const savedCv = request.body?.useSavedCv === true
      ? await profiles.findOne({ _id: user.id, cv: { $exists: true }, cvType: { $in: ["pdf", "docx"] } }, { projection: { cv: 1, cvType: 1 } })
      : null;
    let details;
    try {
      details = readApplication(request.body, savedCv ?? undefined);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Check your application details." });
      return;
    }
    const job = await jobs.findOne({ _id: new ObjectId(jobId), status: "live", closingDate: { $gte: todayInTheUK() } });
    if (!job) {
      response.status(404).json({ message: "This job is no longer accepting applications." });
      return;
    }
    if (job.ownerId === user.id) {
      response.status(403).json({ message: "You can’t apply to a job you posted." });
      return;
    }

    const now = new Date();
    const application: Application = {
      ...details, _id: `${job._id}:${user.id}`, jobId: job._id.toHexString(),
      seekerId: user.id, jobTitle: job.title, companyName: job.companyName,
      companyOwnerId: job.ownerId, status: "new", createdAt: now, consentRecordedAt: now,
    };
    try {
      await applications.insertOne(application);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        response.status(409).json({ message: "You’ve already applied for this job." });
        return;
      }
      throw error;
    }
    response.status(201).json({ message: "Application submitted." });
  });

  router.get("/job-applications/mine", requireSession, async (_request, response) => {
    const results = await applications.find({ seekerId: response.locals.currentUser.id }).project(seekerFields).sort({ createdAt: -1 }).toArray();
    const logos = await companyLogoIds(db, [...new Set(results.map(({ companyOwnerId }) => publicCompanyId(companyOwnerId)))]);
    response.json({ applications: results.map(({ companyOwnerId, ...entry }) => {
      const companyId = publicCompanyId(companyOwnerId);
      return { ...entry, companyLogo: logos.has(companyId) ? `/company-logo/${companyId}` : undefined };
    }) });
  });

  router.get("/admin/job-applications", requireSession, requireAdmin, async (_request, response) => {
    const results = await applications.find().project(privateFields).sort({ createdAt: -1 }).toArray();
    response.json({ applications: results });
  });

  router.patch("/admin/job-applications/:id", requireMutation, requireSession, requireAdmin, async (request, response) => {
    const { id } = request.params;
    const status = request.body?.status;
    if (typeof id !== "string" || (status !== "forwarded" && status !== "not-suitable" && status !== "shortlisted")) {
      response.status(400).json({ message: "Choose Shortlist, Forward or Mark not suitable." });
      return;
    }
    const reviewer = response.locals.currentUser.id;
    const now = new Date();
    const result = await applications.updateOne({ _id: id, status: { $in: status === "shortlisted" ? ["new"] : ["new", "shortlisted"] } }, { $set: {
      status, reviewedAt: now, reviewedBy: reviewer,
      ...(status === "forwarded" ? { forwardedAt: now, forwardedBy: reviewer } : {}),
    } });
    if (!result.modifiedCount) {
      response.status(409).json({ message: "This application is no longer awaiting review. Refresh the inbox." });
      return;
    }
    response.json({ status });
  });

  router.get("/employer/job-applications", requireSession, async (_request, response) => {
    const ownerId = response.locals.currentUser.id;
    const company = await companies.findOne({ _id: ownerId, status: "approved" }, { projection: { _id: 1 } });
    if (!company) {
      response.status(403).json({ message: "Your company must be approved to view forwarded applications." });
      return;
    }
    const results = await applications.find({ companyOwnerId: ownerId, status: "forwarded" }).project(privateFields).sort({ forwardedAt: -1 }).toArray();
    response.json({ applications: results });
  });

  router.patch("/employer/job-applications/:id", requireMutation, requireSession, async (request, response) => {
    const { id } = request.params;
    const { status } = request.body ?? {};
    if (typeof id !== "string" || (status !== "reviewed" && status !== "shortlisted" && status !== "not-suitable")) {
      response.status(400).json({ message: "Choose a valid employer review status." });
      return;
    }
    const ownerId = response.locals.currentUser.id;
    const company = await companies.findOne({ _id: ownerId, status: "approved" }, { projection: { _id: 1 } });
    if (!company) {
      response.status(403).json({ message: "Your company must be approved to review applications." });
      return;
    }
    const result = await applications.updateOne(
      { _id: id, companyOwnerId: ownerId, status: "forwarded" },
      { $set: { employerStatus: status } },
    );
    if (!result.matchedCount) {
      response.status(404).json({ message: "Forwarded application not found." });
      return;
    }
    response.json({ employerStatus: status });
  });

  router.get("/job-applications/:id/cv", requireSession, async (request, response) => {
    const { id } = request.params;
    const user = response.locals.currentUser;
    if (typeof id !== "string") {
      response.sendStatus(404);
      return;
    }
    const application = await applications.findOne({ _id: id, ...(user.role === "admin" ? {} : { companyOwnerId: user.id, status: "forwarded" }) });
    const company = application && user.role !== "admin"
      ? await companies.findOne({ _id: user.id, status: "approved" }, { projection: { _id: 1 } })
      : null;
    if (!application || (user.role !== "admin" && !company)) {
      response.status(404).json({ message: "CV not found." });
      return;
    }
    response.set("Content-Type", cvTypes[application.cvType]);
    response.set("Content-Disposition", `attachment; filename="application-cv.${application.cvType}"`);
    response.set("X-Content-Type-Options", "nosniff");
    response.send(Buffer.from(application.cv.value()));
  });

  return router;
}
