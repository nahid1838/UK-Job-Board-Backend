import { json, Router, type Request, type Response, type NextFunction } from "express";
import { Binary, type Db } from "mongodb";
import { createRequireSession } from "./session-routes.ts";

type SeekerProfile = {
  _id: string; name?: string; phone?: string; location?: string; headline?: string; bio?: string;
  photo?: string; cv?: Binary; cvType?: "pdf" | "docx"; notificationsReadAt?: string;
};

export function createSeekerProfileRoutes(db: Db, frontendOrigin: string) {
  const router = Router();
  const profiles = db.collection<SeekerProfile>("seekerProfiles");
  const employerProfiles = db.collection<SeekerProfile>("employerProfiles");
  const adminProfiles = db.collection<SeekerProfile>("adminProfiles");
  const requireSession = createRequireSession(frontendOrigin);
  const origin = new URL(frontendOrigin).origin;

  function requireSeeker(_request: Request, response: Response, next: NextFunction) {
    if (response.locals.currentUser.role !== "seeker") {
      response.status(403).json({ message: "Sign in as a job seeker to use this page." });
      return;
    }
    next();
  }
  function requireMutation(request: Request, response: Response, next: NextFunction) {
    if (request.get("Origin") !== origin || !request.is("application/json")) {
      response.status(403).json({ message: "Submit this request from the job board." });
      return;
    }
    next();
  }

  function requireEmployer(_request: Request, response: Response, next: NextFunction) {
    if (response.locals.currentUser.role !== "employer") {
      response.status(403).json({ message: "Sign in as an employer to use this page." });
      return;
    }
    next();
  }

  function registerProfileRoutes(path: string, collection: typeof profiles, requireRole: typeof requireSeeker) {
    router.get(path, requireSession, requireRole, async (_request, response) => {
      const profile = await collection.findOne({ _id: response.locals.currentUser.id }, { projection: { cv: 0, _id: 0 } });
      response.json({ profile: profile ?? {} });
    });

    router.patch(path, requireMutation, requireSession, requireRole, json({ limit: "2mb" }), async (request, response) => {
      const fields = { name: 120, phone: 40, location: 120, headline: 120, bio: 1500 };
      const update: Partial<SeekerProfile> = {};
      for (const [key, max] of Object.entries(fields)) {
        const value = request.body?.[key];
        if (value === undefined) continue;
        if (typeof value !== "string" || value.trim().length > max || (key === "name" && !value.trim())) {
          response.status(400).json({ message: "Enter a name and check your profile field lengths." });
          return;
        }
        update[key as keyof typeof fields] = value.trim();
      }
      const photo = request.body?.photo;
      if (photo !== undefined) {
        const match = typeof photo === "string" && photo.length <= 1400000 ? /^data:image\/(png|jpeg);base64,([a-z0-9+/=]+)$/i.exec(photo) : null;
        const bytes = match ? Buffer.from(match[2], "base64") : null;
        const valid = bytes && bytes.length <= 1048576 && bytes.toString("base64") === match?.[2]
          && (match?.[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])));
        if (photo !== "" && !valid) {
          response.status(400).json({ message: "Choose a PNG or JPEG profile photo up to 1 MB." });
          return;
        }
        update.photo = photo;
      }
      if (Object.keys(update).length === 0) {
        response.status(400).json({ message: "Provide at least one profile change." });
        return;
      }
      await collection.updateOne({ _id: response.locals.currentUser.id }, { $set: update }, { upsert: true });
      response.json({ message: "Profile saved." });
    });
  }

  registerProfileRoutes("/seeker/profile", profiles, requireSeeker);
  registerProfileRoutes("/employer/profile", employerProfiles, requireEmployer);
  registerProfileRoutes("/admin/profile", adminProfiles, (_request, response, next) => {
    if (response.locals.currentUser.role !== "admin") {
      response.status(403).json({ message: "Only admins can access this profile." });
      return;
    }
    next();
  });

  router.put("/seeker/cv", requireMutation, requireSession, requireSeeker, json({ limit: "7mb" }), async (request, response) => {
    const encoded = request.body?.file;
    const bytes = typeof encoded === "string" && encoded.length <= 6990508 ? Buffer.from(encoded, "base64") : null;
    const pdf = bytes?.subarray(0, 5).toString() === "%PDF-";
    const docx = bytes?.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) && bytes.includes(Buffer.from("word/document.xml"));
    if (!bytes || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== encoded || (!pdf && !docx)) {
      response.status(400).json({ message: "Choose a PDF or DOCX file up to 5 MB." });
      return;
    }
    await profiles.updateOne({ _id: response.locals.currentUser.id }, { $set: { cv: new Binary(bytes), cvType: pdf ? "pdf" : "docx" } }, { upsert: true });
    response.json({ message: "CV saved." });
  });

  router.get("/seeker/cv", requireSession, requireSeeker, async (_request, response) => {
    const profile = await profiles.findOne({ _id: response.locals.currentUser.id }, { projection: { cv: 1, cvType: 1 } });
    if (!profile?.cv || !profile.cvType) { response.sendStatus(404); return; }
    response.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="my-cv.${profile.cvType}"`, "X-Content-Type-Options": "nosniff" });
    response.send(Buffer.from(profile.cv.value()));
  });
  router.delete("/seeker/cv", requireMutation, requireSession, requireSeeker, async (_request, response) => {
    await profiles.updateOne({ _id: response.locals.currentUser.id }, { $unset: { cv: "", cvType: "" } });
    response.json({ message: "CV removed." });
  });

  router.patch("/seeker/notifications", requireMutation, requireSession, requireSeeker, async (request, response) => {
    const timestamp = typeof request.body?.through === "string" ? new Date(request.body.through).getTime() : NaN;
    if (!Number.isFinite(timestamp) || timestamp > Date.now()) {
      response.status(400).json({ message: "Refresh your notifications and try again." });
      return;
    }
    await profiles.updateOne({ _id: response.locals.currentUser.id }, { $max: { notificationsReadAt: new Date(timestamp).toISOString() } }, { upsert: true });
    response.json({ message: "Notifications marked as read." });
  });
  return router;
}
