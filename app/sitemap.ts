import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";
import { TOOLS } from "@/lib/tools";
import { LEGAL_UPDATED } from "@/lib/business";

const base = siteUrl();

/**
 * The pages worth finding in search: home, the catalogue, pricing, every
 * shown tool and the legal pages. Log in and Sign up are left out (they are
 * noindex). Only the legal pages carry a date, the day they last changed; a
 * build's own date on every other page would say they all changed with it.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = ["", "/tools", "/pricing"].map((path) => ({
    url: `${base}${path}`,
    changeFrequency: "weekly" as const,
    priority: path === "" ? 1 : 0.7,
  }));

  const legalRoutes = ["/privacy", "/terms", "/refunds", "/security", "/contact"].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(`${LEGAL_UPDATED}T12:00:00Z`),
    changeFrequency: "yearly" as const,
    priority: 0.3,
  }));

  const toolRoutes = TOOLS.map((t) => ({
    url: `${base}/tools/${t.slug}`,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  return [...staticRoutes, ...toolRoutes, ...legalRoutes];
}
