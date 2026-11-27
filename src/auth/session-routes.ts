import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

export function createRequireSession(frontendOrigin: string) {
  const sessionUrl = new URL("/api/auth/get-session", frontendOrigin);
  sessionUrl.searchParams.set("disableCookieCache", "true");
  sessionUrl.searchParams.set("disableRefresh", "true");

  return async function requireSession(request: Request, response: Response, next: NextFunction) {
    response.set("Cache-Control", "no-store");

    const cookie = request.headers.cookie;
    if (!cookie) {
      response.status(401).json({ message: "Sign in to continue." });
      return;
    }

    try {
      // Better Auth in Next.js verifies the cookie against the current session.
      const result = await fetch(sessionUrl, {
        headers: { cookie },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!result.ok) throw new Error("Better Auth returned an error.");

      const session = await result.json() as {
        user: { id: string; role?: string; accountType?: string; active?: boolean };
      } | null;

      if (session === null) {
        response.status(401).json({ message: "Sign in to continue." });
        return;
      }

      const { user } = session;
      if (typeof user?.id !== "string" || !user.id) {
        throw new Error("Better Auth returned an invalid session.");
      }
      if (user.active === false) {
        response.status(403).json({ message: "This account is disabled." });
        return;
      }

      // Match Next.js routing for accounts created before the role field existed.
      const role = user.role === "admin" || user.role === "employer" || user.role === "seeker"
        ? user.role
        : user.accountType === "employer" ? "employer" : "seeker";

      response.locals.currentUser = { id: user.id, role };
    } catch {
      response.status(503).json({ message: "Could not verify your session. Try again shortly." });
      return;
    }

    next();
  };
}

export function createSessionRoutes(frontendOrigin: string) {
  const router = Router();
  const requireSession = createRequireSession(frontendOrigin);

  router.get("/me", requireSession, (_request, response) => {
    response.json({ user: response.locals.currentUser });
  });

  router.get("/admin/check", requireSession, (_request, response) => {
    if (response.locals.currentUser.role !== "admin") {
      response.status(403).json({ message: "Only admins can access this endpoint." });
      return;
    }

    response.json({ message: "Admin access verified." });
  });

  return router;
}
