import Link from "next/link";
import { TOOLS, CATEGORY_LABELS, type ToolCategory } from "@/lib/tools";
import { cn } from "@/lib/utils";

const ORDER: ToolCategory[] = [
  "organize",
  "optimize",
  "convert",
  "extract",
  "edit",
];

export function ToolGrid({ compact = false }: { compact?: boolean }) {
  return (
    <div className="space-y-12">
      {ORDER.map((category) => {
        const tools = TOOLS.filter((t) => t.category === category);
        if (!tools.length) return null;
        return (
          <section key={category}>
            {!compact && (
              <h2 className="mb-5 text-lg font-semibold tracking-tight">
                {CATEGORY_LABELS[category]}
              </h2>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {tools.map((tool) => (
                <Link
                  key={tool.slug}
                  href={`/tools/${tool.slug}`}
                  className="group flex items-start gap-4 rounded-2xl border border-border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg"
                >
                  <div
                    className={cn(
                      "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
                      tool.tint
                    )}
                  >
                    <tool.icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="flex items-center gap-2 font-semibold group-hover:text-primary">
                      {tool.name}
                      {tool.badge && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          {tool.badge}
                        </span>
                      )}
                    </h3>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {tool.description}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
