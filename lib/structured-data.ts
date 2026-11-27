import { metaDescription, type ToolMeta } from "./tools";

/**
 * Schema.org data for search results: the site's name on the home page, and
 * on a tool page the path to it (Home › All tools › tool, as its "All tools"
 * link shows) and the tool as a free web app. Built from what the page
 * shows, so the two can't disagree.
 */
type JsonLd = Record<string, unknown>;

const SITE_NAME = "PDF Wizard";

export function siteJsonLd(base: string): JsonLd {
  // The home page's address as its canonical link gives it, with no trailing slash.
  return { "@context": "https://schema.org", "@type": "WebSite", name: SITE_NAME, url: base };
}

export function toolJsonLd(tool: ToolMeta, base: string): JsonLd {
  const url = `${base}/tools/${tool.slug}`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: base },
          { "@type": "ListItem", position: 2, name: "All tools", item: `${base}/tools` },
          { "@type": "ListItem", position: 3, name: tool.name, item: url },
        ],
      },
      {
        "@type": "WebApplication",
        name: tool.name,
        url,
        description: metaDescription(tool),
        applicationCategory: tool.category === "media" ? "MultimediaApplication" : "BusinessApplication",
        operatingSystem: "Any",
        browserRequirements: "Requires JavaScript",
        // Pro-only tools aren't offered free.
        ...(tool.badge === "Pro" ? {} : { offers: { "@type": "Offer", price: "0", priceCurrency: "ZAR" } }),
      },
    ],
  };
}

/** For a <script type="application/ld+json">: "<" escaped so the text can't close the tag. */
export function jsonLdHtml(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
