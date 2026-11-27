import { createHash } from "node:crypto";
import { Router } from "express";
import type { Db } from "mongodb";
import type { CompanyApplication } from "./company-routes.ts";
import type { Job } from "../jobs/job-routes.ts";
import { companyLogoIds } from "./company-logos.ts";

export function publicCompanyId(ownerId: string) {
  return createHash("sha256").update(`uk-job-board-company:${ownerId}`).digest("hex").slice(0, 24);
}

export function createPublicCompanyRoutes(db: Db, today: () => string) {
  const router = Router();
  const companies = db.collection<CompanyApplication>("companyApplications");
  const jobs = db.collection<Job>("jobs");
  const liveJobs = () => ({ status: "live", closingDate: { $gte: today() } }) as const;

  async function approvedCompanies() {
    return companies.find({ status: "approved" }).project<{
      _id: string; details: Pick<CompanyApplication["details"], "name" | "town" | "description" | "industry" | "size" | "website">;
    }>({
      "details.name": 1, "details.town": 1, "details.description": 1,
      "details.industry": 1, "details.size": 1, "details.website": 1,
    }).toArray();
  }

  router.get("/companies", async (_request, response) => {
    const [approved, counts] = await Promise.all([
      approvedCompanies(),
      jobs.aggregate<{ _id: string; jobCount: number }>([
        { $match: liveJobs() },
        { $group: { _id: "$ownerId", jobCount: { $sum: 1 } } },
      ]).toArray(),
    ]);
    const countByOwner = new Map(counts.map(({ _id, jobCount }) => [_id, jobCount]));
    const logoIds = await companyLogoIds(db, approved.map(({ _id }) => publicCompanyId(_id)));
    const results = approved.map(({ _id, details }) => ({
      id: publicCompanyId(_id), name: details.name, town: details.town, industry: details.industry,
      logoUrl: logoIds.has(publicCompanyId(_id)) ? `/company-logo/${publicCompanyId(_id)}` : undefined,
      jobCount: countByOwner.get(_id) ?? 0,
    })).sort((a, b) => b.jobCount - a.jobCount || a.name.localeCompare(b.name, "en-GB"));
    response.json({ companies: results });
  });

  router.get("/companies/:id", async (request, response) => {
    const { id } = request.params;
    const company = typeof id === "string" && /^[a-f0-9]{24}$/.test(id)
      ? (await approvedCompanies()).find(({ _id }) => publicCompanyId(_id) === id)
      : undefined;
    if (!company) {
      response.status(404).json({ message: "Company not found." });
      return;
    }
    const openJobs = await jobs.find({ ...liveJobs(), ownerId: company._id }).project({ ownerId: 0 }).sort({ publishedAt: -1 }).limit(100).toArray();
    const logoIds = await companyLogoIds(db, [id]);
    const logoUrl = logoIds.has(id) ? `/company-logo/${id}` : undefined;
    response.json({ company: { id, ...company.details, logoUrl }, jobs: openJobs.map((job) => ({
      ...job, companyId: id, companyLogo: logoUrl,
      isFeatured: Boolean(job.featuredUntil && job.featuredUntil > new Date()),
    })) });
  });

  return router;
}
