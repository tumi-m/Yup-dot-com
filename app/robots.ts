import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

const base = siteUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/auth/", "/dashboard", "/edit/", "/editor", "/settings"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
