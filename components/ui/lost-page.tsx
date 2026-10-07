import { Aurora, HatShadow, Starfield, WizardHatArt } from "@/components/landing/HeroScene";

/** The themed body shared by the 404 and error pages: hat, heading, actions. */
export function LostPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main id="main" className="relative flex flex-1 items-center justify-center overflow-hidden bg-gradient-to-b from-primary/10 via-background to-background px-4 py-20">
      <Aurora />
      <Starfield />
      <div className="relative flex flex-col items-center text-center">
        <div className="relative h-40 w-40 motion-safe:animate-pop">
          <HatShadow className="-bottom-3 left-[10%] h-8 w-[80%]" />
          <div className="h-full w-full origin-bottom motion-safe:animate-wobble">
            <WizardHatArt />
          </div>
        </div>
        <h1 className="mt-8 text-3xl font-extrabold tracking-tight motion-safe:animate-rise [animation-delay:0.1s] sm:text-4xl">
          {title}
        </h1>
        <div className="mt-8 flex flex-wrap justify-center gap-3 motion-safe:animate-rise [animation-delay:0.15s]">
          {children}
        </div>
      </div>
    </main>
  );
}
