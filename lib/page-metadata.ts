import type { Metadata, ResolvingMetadata } from "next";

/**
 * A page's metadata, with what a shared link shows (og: tags, and twitter:
 * tags, which Next.js fills from them) set to the page's own title and
 * description. A page that sets only a title and description is otherwise
 * shared with the home page's. Keeps the site's shared-link image, which a
 * page's own openGraph replaces.
 */
export async function pageMetadata(
  page: { title: string; description: string; path: string },
  parent: ResolvingMetadata
): Promise<Metadata> {
  const images = (await parent).openGraph?.images ?? [];
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: page.path },
    openGraph: { type: "website", title: page.title, description: page.description, url: page.path, images },
  };
}
