import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Log in", alternates: { canonical: "/login" } };

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
