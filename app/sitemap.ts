import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";
import { TOOLS } from "@/lib/tools";
import { LEGAL_UPDATED } from "@/lib/business";

const base = siteUrl();

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = ["", "/tools", "/pricing", "/login", "/signup"].map(
    (path) => ({
      url: `${base}${path}`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: path === "" ? 1 : 0.7,
    })
  );

  const legalRoutes = ["/privacy", "/terms", "/refunds", "/contact"].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(`${LEGAL_UPDATED}T12:00:00Z`),
    changeFrequency: "yearly" as const,
    priority: 0.3,
  }));

  const toolRoutes = TOOLS.map((t) => ({
    url: `${base}/tools/${t.slug}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  return [...staticRoutes, ...toolRoutes, ...legalRoutes];
}
