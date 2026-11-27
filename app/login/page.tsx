import type { ResolvingMetadata } from "next";
import { AuthForm } from "@/components/AuthForm";
import { pageMetadata } from "@/lib/page-metadata";

// Its own description on shared links, and kept out of search results: the
// sign-in pages have nothing to find.
export async function generateMetadata(_: unknown, parent: ResolvingMetadata) {
  return {
    ...(await pageMetadata({ title: "Log in", description: "Log in to PDF Wizard to open your library and plan.", path: "/login" }, parent)),
    alternates: {},
    robots: { index: false, follow: true },
  };
}

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
