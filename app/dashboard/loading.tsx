import { NavSkeleton, Skeleton, TopProgress } from "@/components/ui/skeleton";

/** Matches the dashboard: heading, then the document grid. */
export default function DashboardLoading() {
  return (
    <div className="min-h-screen">
      <TopProgress />
      <NavSkeleton />
      <main id="main" aria-busy="true" className="container py-10">
        <div className="flex items-end justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-9 w-56 max-w-full rounded-lg" />
            <Skeleton className="h-4 w-24 rounded-md" />
          </div>
          <Skeleton className="h-10 w-32 rounded-lg" />
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className={i > 1 ? "hidden h-60 lg:block" : "h-60"} />
          ))}
        </div>
      </main>
    </div>
  );
}
