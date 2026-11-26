import type { Metadata, ResolvingMetadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { MarketingNav } from "@/components/MarketingNav";
import { ToolPanel } from "@/components/tools/ToolPanel";
import { panelSpec, placeholderSize, ToolPlaceholder } from "@/components/tools/panel-spec";
import { TOOLS, getTool } from "@/lib/tools";
import { getCurrentUser } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import type { Tier } from "@/lib/limits";
import { Suspense } from "react";
import { pageMetadata } from "@/lib/page-metadata";
import { ToolHeader, RelatedTools } from "@/components/tools/ToolHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Starfield } from "@/components/landing/HeroScene";
import { SampleFinderAbout } from "@/components/tools/SampleFinderAbout";
import { PagesAbout } from "@/components/tools/PagesAbout";
import { ResizeAbout } from "@/components/tools/ResizeAbout";
import { FlattenAbout } from "@/components/tools/FlattenAbout";
import { CropAbout } from "@/components/tools/CropAbout";
import { ConvertAbout } from "@/components/tools/ConvertAbout";
import { RepairAbout } from "@/components/tools/RepairAbout";
import { ScanAbout } from "@/components/tools/ScanAbout";

export function generateStaticParams() {
  return TOOLS.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata(
  {
    params,
  }: {
    params: Promise<{ slug: string }>;
  },
  parent: ResolvingMetadata
): Promise<Metadata> {
  const { slug } = await params;
  const tool = getTool(slug);
  if (!tool) return { title: "Tool not found" };
  return pageMetadata({ title: tool.title, description: tool.description, path: `/tools/${tool.slug}` }, parent);
}

export default async function ToolPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tool = getTool(slug);
  if (!tool) notFound();

  const user = await getCurrentUser();
  const profile = user ? await getProfile().catch(() => null) : null;
  const tier: Tier = profile?.plan ?? "guest";
  const spec = panelSpec(tool);

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main id="main" className="relative flex-1 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-primary/10 to-transparent" />
        <Starfield className="h-[420px]" />
        <div className="container relative py-10">
          <Link
            href="/tools"
            className="tap group mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" /> All tools
          </Link>

          <div className="mx-auto max-w-2xl">
            <ToolHeader slug={tool.slug} />
            <div className="mt-10">
              {/* The tool reads search params, so it renders after hydration;
                  a placeholder of its usual size keeps the page from jumping. */}
              <Suspense fallback={<ToolPlaceholder className={placeholderSize(spec.kind)} />}>
                <ToolPanel spec={spec} tier={tier} />
              </Suspense>
            </div>
          </div>

          {tool.slug === "sample-finder" && <SampleFinderAbout />}
          {tool.pages && <PagesAbout mode={tool.pages.mode} />}
          {tool.slug === "resize-pdf" && <ResizeAbout />}
          {tool.slug === "flatten-pdf" && <FlattenAbout />}
          {tool.slug === "crop-pdf" && <CropAbout />}
          <ConvertAbout slug={tool.slug} />
          {tool.slug === "repair-pdf" && <RepairAbout />}
          {tool.slug === "scan-to-pdf" && <ScanAbout />}

          <RelatedTools slug={tool.slug} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
