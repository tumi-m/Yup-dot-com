import { Starfield } from "@/components/landing/HeroScene";
import { NavSkeleton, Skeleton, TopProgress } from "@/components/ui/skeleton";

/** Matches the pricing page: title, then three plan cards. */
export default function PricingLoading() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopProgress />
      <NavSkeleton />
      <main id="main" aria-busy="true" className="relative flex-1 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-gradient-to-b from-primary/10 to-transparent" />
        <Starfield className="h-[480px]" />
        <div className="container relative py-16 sm:py-20">
          <Skeleton className="mx-auto h-12 w-80 max-w-full" />
          <div className="mx-auto mt-14 grid max-w-md gap-6 lg:max-w-none lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className={i === 1 ? "h-[30rem] rounded-3xl" : "hidden h-[30rem] rounded-3xl lg:block"} />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
