import type { MetadataRoute } from "next";
import { TOOLS } from "@/lib/tools";

const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://pdfwizard.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = ["", "/tools", "/pricing", "/login", "/signup"].map(
    (path) => ({
      url: `${base}${path}`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: path === "" ? 1 : 0.7,
    })
  );

  const toolRoutes = TOOLS.map((t) => ({
    url: `${base}/tools/${t.slug}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  return [...staticRoutes, ...toolRoutes];
}
