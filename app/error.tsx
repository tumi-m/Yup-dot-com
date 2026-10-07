"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NavSkeleton } from "@/components/ui/skeleton";
import { LostPage } from "@/components/ui/lost-page";

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col">
      <NavSkeleton bare />
      <LostPage title="A spell misfired">
        <Button size="lg" onClick={() => retry()}>
          Try again
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/">Back home</Link>
        </Button>
      </LostPage>
    </div>
  );
}
