import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Sign up", alternates: { canonical: "/signup" } };

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
