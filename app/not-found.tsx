import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "@/components/MarketingNav";
import { LostPage } from "@/components/ui/lost-page";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata = { title: "Page not found" };

export default async function NotFound() {
  const user = await getCurrentUser().catch(() => null);
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <LostPage title="Page not found">
        <Button asChild size="lg">
          <Link href="/">Back home</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/tools">All tools</Link>
        </Button>
      </LostPage>
    </div>
  );
}
