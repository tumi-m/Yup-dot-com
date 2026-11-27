import type { ResolvingMetadata } from "next";
import { AuthForm } from "@/components/AuthForm";
import { pageMetadata } from "@/lib/page-metadata";

// Its own description on shared links, and kept out of search results (app/login/page.tsx).
export async function generateMetadata(_: unknown, parent: ResolvingMetadata) {
  return {
    ...(await pageMetadata({ title: "Reset password", description: "Get a link to choose a new PDF Wizard password.", path: "/forgot-password" }, parent)),
    robots: { index: false, follow: true },
  };
}

export default function ForgotPasswordPage() {
  return <AuthForm mode="reset" />;
}
