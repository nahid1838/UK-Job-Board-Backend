import type { Db } from "mongodb";

export type SiteSettings = { _id: "site"; contactEmail: string; featuredDays: number };
export const emailTemplates = {
  companySubmitted: { subject: "New company application", text: "A company application for {{company}} is ready for review." },
  companyApproved: { subject: "Company approved", text: "{{company}} is approved. Sign in to post jobs." },
  companyRejected: { subject: "Company application decision", text: "Your application for {{company}} was rejected. Reason: {{reason}}. Sign in to update your application." },
  applicationSubmitted: { subject: "Job application received", text: "We received your application for {{job}}. An admin will review it." },
  applicationReceived: { subject: "New job application to review", text: "An application for {{job}} is in the admin inbox." },
  applicationForwarded: { subject: "Job application forwarded", text: "An admin forwarded an application for {{job}}. Sign in to see the application and download the CV." },
};
export type TemplateKey = keyof typeof emailTemplates;
export type EmailTemplate = { _id: TemplateKey; subject: string; text: string };

export async function getSiteSettings(db: Db): Promise<SiteSettings> {
  return await db.collection<SiteSettings>("siteSettings").findOne({ _id: "site" }) ?? {
    _id: "site", contactEmail: process.env.SITE_CONTACT_EMAIL ?? "", featuredDays: 7,
  };
}

export async function recordActivity(db: Db, actorId: string, action: string, target: string) {
  try {
    await db.collection("activityLog").insertOne({ actorId, action, target, createdAt: new Date() });
  } catch (error) {
    console.error("Could not record admin activity", error instanceof Error ? error.name : "unknown error");
  }
}

export async function notify(db: Db, key: TemplateKey, to: string, values: Record<string, string>) {
  if (!to || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return;
  try {
    const template = await db.collection<EmailTemplate>("emailTemplates").findOne({ _id: key }) ?? emailTemplates[key];
    const fill = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (_match, field: string) => values[field] ?? "");
    const result = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM, to: [to],
        subject: fill(template.subject).replace(/[\r\n]/g, " "), text: fill(template.text),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!result.ok) console.error("Workflow email delivery failed", key, result.status);
  } catch (error) {
    console.error("Workflow email delivery failed", key, error instanceof Error ? error.name : "unknown error");
  }
}
