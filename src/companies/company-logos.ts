import { json, Router, type Request, type Response, type NextFunction } from "express";
import { Binary, type Db } from "mongodb";
import { createRequireSession } from "../auth/session-routes.ts";
import type { CompanyApplication } from "./company-routes.ts";
import { publicCompanyId } from "./public-companies.ts";

const maxLogoBytes = 2 * 1024 * 1024;
type CompanyLogo = { _id: string; bytes: Binary; mime: "image/png" | "image/jpeg" };

export async function companyLogoIds(db: Db, companyIds: string[]) {
  const logos = await db.collection<CompanyLogo>("companyLogos").find({ _id: { $in: companyIds } }).project({ _id: 1 }).toArray();
  return new Set(logos.map(({ _id }) => _id));
}

export function createCompanyLogoRoutes(db: Db, frontendOrigin: string) {
  const router = Router();
  const logos = db.collection<CompanyLogo>("companyLogos");
  const companies = db.collection<CompanyApplication>("companyApplications");
  const requireSession = createRequireSession(frontendOrigin);
  const origin = new URL(frontendOrigin).origin;

  function sameOrigin(request: Request, response: Response, next: NextFunction) {
    if (request.get("Origin") !== origin || !request.is("application/json")) {
      response.status(403).json({ message: "Upload your logo from the job board." });
      return;
    }
    next();
  }

  router.put("/company-logo", sameOrigin, requireSession, json({ limit: "3mb" }), async (request, response) => {
    const ownerId = response.locals.currentUser.id;
    if (!await companies.findOne({ _id: ownerId, status: "approved" }, { projection: { _id: 1 } })) {
      response.status(403).json({ message: "An approved company can upload a logo." });
      return;
    }
    const encoded = request.body?.image;
    const bytes = typeof encoded === "string" && encoded.length <= Math.ceil(maxLogoBytes / 3) * 4
      ? Buffer.from(encoded, "base64") : null;
    let mime: CompanyLogo["mime"] | undefined;
    if (bytes?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = "image/png";
    if (bytes?.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) mime = "image/jpeg";
    if (!bytes || !mime || bytes.length > maxLogoBytes || bytes.toString("base64") !== encoded) {
      response.status(400).json({ message: "Choose a valid PNG or JPEG logo up to 2 MB." });
      return;
    }
    const id = publicCompanyId(ownerId);
    await logos.updateOne({ _id: id }, { $set: { bytes: new Binary(bytes), mime } }, { upsert: true });
    response.json({ logoUrl: `/company-logo/${id}` });
  });

  router.get("/company-logos/:id", async (request, response) => {
    const { id } = request.params;
    const logo = typeof id === "string" && /^[a-f0-9]{24}$/.test(id) ? await logos.findOne({ _id: id }) : null;
    if (!logo) {
      response.sendStatus(404);
      return;
    }
    response.set({ "Content-Type": logo.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
    response.send(Buffer.from(logo.bytes.value()));
  });
  return router;
}
