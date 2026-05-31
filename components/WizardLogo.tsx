import { cn } from "@/lib/utils";

/**
 * A pointed wizard hat with a star — the PDF Wizard mark.
 * Generic fantasy-wizard imagery (no franchise references).
 */
export function WizardHat({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("h-5 w-5", className)}
      aria-hidden="true"
    >
      {/* hat brim */}
      <path
        d="M3 19.5c0-1 4-2 9-2s9 1 9 2-4 2-9 2-9-1-9-2Z"
        fill="currentColor"
        opacity="0.35"
      />
      {/* hat cone, slightly bent at the tip */}
      <path
        d="M12 2.2c.5 0 .8.3 1 .8l5.4 14.4c.2.5-.2 1-.8 1.1-1.4.3-3.4.5-5.6.5s-4.2-.2-5.6-.5c-.6-.1-1-.6-.8-1.1L11 3c.2-.5.5-.8 1-.8Z"
        fill="currentColor"
      />
      {/* star on the hat */}
      <path
        d="M12 7.4l.7 1.6 1.7.2-1.3 1.2.4 1.7-1.5-.9-1.5.9.4-1.7-1.3-1.2 1.7-.2.7-1.6Z"
        fill="#fde047"
      />
    </svg>
  );
}

export function WizardWordmark({
  className,
  iconClassName,
}: {
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2 font-bold", className)}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <WizardHat className={cn("h-4 w-4", iconClassName)} />
      </span>
      PDF&nbsp;Wizard
    </span>
  );
}
