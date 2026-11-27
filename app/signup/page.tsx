import type { ResolvingMetadata } from "next";
import { AuthForm } from "@/components/AuthForm";
import { pageMetadata } from "@/lib/page-metadata";

// Its own description on shared links, and kept out of search results (app/login/page.tsx).
export async function generateMetadata(_: unknown, parent: ResolvingMetadata) {
  return {
    ...(await pageMetadata({ title: "Sign up", description: "Create a free PDF Wizard account to keep your documents in a cloud library.", path: "/signup" }, parent)),
    alternates: {},
    robots: { index: false, follow: true },
  };
}

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
