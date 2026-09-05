import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

const base = siteUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/editor", "/settings", "/api"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
