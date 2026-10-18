import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Reset password", alternates: { canonical: "/forgot-password" } };

export default function ForgotPasswordPage() {
  return <AuthForm mode="reset" />;
}
