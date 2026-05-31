import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { MarketingNav } from "@/components/MarketingNav";
import { ToolWorkbench } from "@/components/tools/ToolWorkbench";
import { EditorLaunch } from "@/components/tools/EditorLaunch";
import { TOOLS, getTool } from "@/lib/tools";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export function generateStaticParams() {
  return TOOLS.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tool = getTool(slug);
  if (!tool) return { title: "Tool not found — PDF Wizard" };
  return {
    title: `${tool.title} | PDF Wizard`,
    description: tool.description,
    alternates: { canonical: `/tools/${tool.slug}` },
    openGraph: { title: tool.title, description: tool.description },
  };
}

export default async function ToolPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tool = getTool(slug);
  if (!tool) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main className="container flex-1 py-12">
        <Link
          href="/tools"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> All tools
        </Link>

        <div className="mx-auto max-w-xl">
          <div className="text-center">
            <div
              className={cn(
                "mx-auto flex h-14 w-14 items-center justify-center rounded-2xl",
                tool.tint
              )}
            >
              <tool.icon className="h-7 w-7" />
            </div>
            <h1 className="mt-4 text-3xl font-bold tracking-tight">{tool.name}</h1>
            <p className="mt-2 text-muted-foreground">{tool.description}</p>
          </div>

          <div className="mt-10">
            {tool.editor ? <EditorLaunch /> : <ToolWorkbench slug={tool.slug} />}
          </div>
        </div>
      </main>
    </div>
  );
}
