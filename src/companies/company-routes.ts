import { Router, type Request, type Response, type NextFunction } from "express";
import { MongoServerError, type Db } from "mongodb";
import { createRequireSession } from "../auth/session-routes.ts";
import { publicCompanyId } from "./public-companies.ts";
import { companyLogoIds } from "./company-logos.ts";

const fieldLimits = {
  name: 120, registrationNumber: 8, address: 180, town: 100, postcode: 10,
  website: 300, description: 2000, industry: 100, size: 20,
  contactName: 120, contactEmail: 254, contactPhone: 40,
} as const;

type CompanyDetails = Record<keyof typeof fieldLimits, string> & { acceptedTerms: true };
export type CompanyApplication = {
  _id: string;
  details: CompanyDetails;
  status: "pending" | "approved" | "rejected";
  revision: number;
  submittedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  rejectionReason?: string;
};

function validateDetails(body: Record<string, unknown>) {
  const details = Object.fromEntries(Object.keys(fieldLimits).map((key) => {
    const value = body[key];
    return [key, typeof value === "string" ? value.trim() : ""];
  })) as Record<keyof typeof fieldLimits, string>;

  for (const [key, limit] of Object.entries(fieldLimits)) {
    const value = details[key as keyof typeof fieldLimits];
    if ((!value && key !== "registrationNumber") || value.length > limit) {
      throw new Error("Complete all required company fields and check their lengths.");
    }
  }
  if (details.registrationNumber && !/^[A-Z0-9]{8}$/i.test(details.registrationNumber)) {
    throw new Error("Enter an 8-character Companies House number.");
  }
  if (!/^(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i.test(details.postcode)) {
    throw new Error("Enter a valid UK postcode.");
  }
  if (!/^https?:\/\/[^\s]+$/i.test(details.website) || !URL.canParse(details.website)) {
    throw new Error("Enter a company website beginning with https:// or http://.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.contactEmail)) {
    throw new Error("Enter a valid work email address.");
  }
  if (!["1-10", "11-50", "51-200", "201-500", "500+"].includes(details.size)) {
    throw new Error("Choose a company size.");
  }
  if (body.acceptedTerms !== true) {
    throw new Error("Accept the Terms and Privacy Policy before submitting.");
  }
  return { ...details, acceptedTerms: true } satisfies CompanyDetails;
}

export function createCompanyRoutes(db: Db, frontendOrigin: string) {
  const router = Router();
  const applications = db.collection<CompanyApplication>("companyApplications");
  const requireSession = createRequireSession(frontendOrigin);
  const allowedOrigin = new URL(frontendOrigin).origin;

  function requireJsonMutation(request: Request, response: Response, next: NextFunction) {
    if (request.get("Origin") !== allowedOrigin || !request.is("application/json")) {
      response.status(403).json({ message: "Submit this request from the job board." });
      return;
    }
    next();
  }

  function requireAdmin(_request: Request, response: Response, next: NextFunction) {
    if (response.locals.currentUser.role !== "admin") {
      response.status(403).json({ message: "Only admins can review company applications." });
      return;
    }
    next();
  }

  router.get("/company-application", requireSession, async (_request, response) => {
    const application = await applications.findOne({ _id: response.locals.currentUser.id });
    if (application?.status !== "approved") {
      response.json({ application });
      return;
    }
    const id = publicCompanyId(application._id);
    const logos = await companyLogoIds(db, [id]);
    response.json({ application: { ...application, logoUrl: logos.has(id) ? `/company-logo/${id}` : undefined } });
  });

  router.post("/company-application", requireJsonMutation, requireSession, async (request, response) => {
    const user = response.locals.currentUser;
    if (user.role === "admin") {
      response.status(403).json({ message: "Use a job seeker or employer account to apply." });
      return;
    }

    let details;
    try {
      details = validateDetails(request.body ?? {});
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Check your company details." });
      return;
    }

    const submission = { details, status: "pending" as const, submittedAt: new Date() };
    try {
      // The account ID is the unique application ID, including on resubmission.
      const application = await applications.findOneAndUpdate(
        { _id: user.id, status: "rejected" },
        { $set: submission, $inc: { revision: 1 }, $unset: { reviewedAt: "", reviewedBy: "", rejectionReason: "" } },
        { upsert: true, returnDocument: "after" },
      );
      response.status(201).json({ application });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        response.status(409).json({ message: "You already have a pending or approved company application. Refresh to see its current status." });
        return;
      }
      throw error;
    }
  });

  router.get("/admin/company-applications", requireSession, requireAdmin, async (_request, response) => {
    const pending = await applications.find({ status: "pending" }).sort({ submittedAt: 1 }).toArray();
    response.json({ applications: pending });
  });

  router.patch("/admin/company-applications/:id", requireJsonMutation, requireSession, requireAdmin, async (request, response) => {
    const { status, revision } = request.body ?? {};
    const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : "";
    if ((status !== "approved" && status !== "rejected") || !Number.isInteger(revision)
      || (status === "rejected" && (!reason || reason.length > 1000))) {
      response.status(400).json({ message: "Choose a decision and provide a reason of up to 1,000 characters when rejecting." });
      return;
    }

    const reviewed = await applications.findOneAndUpdate(
      { _id: request.params.id, status: "pending", revision },
      { $set: {
        status, reviewedAt: new Date(), reviewedBy: response.locals.currentUser.id,
        ...(status === "rejected" ? { rejectionReason: reason } : {}),
      } },
      { returnDocument: "after" },
    );
    if (!reviewed) {
      response.status(409).json({ message: "This application has already changed. Refresh the queue before reviewing again." });
      return;
    }
    response.json({ application: reviewed });
  });

  return router;
}
