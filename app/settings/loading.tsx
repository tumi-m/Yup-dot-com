import { NavSkeleton, Skeleton, TopProgress } from "@/components/ui/skeleton";

/** Matches billing: heading, current plan, then the plan cards. */
export default function SettingsLoading() {
  return (
    <div className="min-h-screen">
      <TopProgress />
      <NavSkeleton />
      <main id="main" aria-busy="true" className="container max-w-5xl py-10">
        <Skeleton className="h-9 w-40 rounded-lg" />
        <Skeleton className="mt-6 h-36" />
        <div className="mx-auto mt-12 grid max-w-md gap-6 lg:max-w-none lg:grid-cols-3">
          <Skeleton className="h-[26rem] rounded-3xl" />
          <Skeleton className="hidden h-[26rem] rounded-3xl lg:block" />
          <Skeleton className="hidden h-[26rem] rounded-3xl lg:block" />
        </div>
      </main>
    </div>
  );
}
