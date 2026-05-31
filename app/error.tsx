"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-2xl font-semibold">A spell misfired</h1>
      <p className="max-w-sm text-muted-foreground">
        Something went wrong. Try again, or head back home.
      </p>
      <div className="flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/">Back home</Link>
        </Button>
      </div>
    </div>
  );
}
