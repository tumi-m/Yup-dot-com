"use client";

import { useId, useState } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";

const TOPICS = ["General", "Billing or refund", "Privacy request", "Copyright complaint", "Bug report"] as const;

/** No backend: builds a mailto: link and opens the visitor's email app. */
export function mailtoHref(email: string, subject: string, message: string): string {
  const params = [`subject=${encodeURIComponent(subject)}`];
  if (message.trim()) params.push(`body=${encodeURIComponent(message.trim())}`);
  return `mailto:${email}?${params.join("&")}`;
}

export function ContactForm({ email, name }: { email: string; name: string }) {
  const id = useId();
  const [topic, setTopic] = useState<string>(TOPICS[0]);
  const [message, setMessage] = useState("");
  const field =
    "w-full rounded-lg border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

  return (
    <form
      className="mt-8 space-y-4 rounded-2xl border border-border bg-card p-5 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        window.location.href = mailtoHref(email, `${topic} (${name})`, message);
      }}
    >
      <div>
        <label htmlFor={`${id}-topic`} className="text-sm font-medium">
          Topic
        </label>
        <select
          id={`${id}-topic`}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className={`${field} mt-1.5 h-11`}
        >
          {TOPICS.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-message`} className="text-sm font-medium">
          Message
        </label>
        <textarea
          id={`${id}-message`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          className={`${field} mt-1.5 block py-2`}
        />
      </div>
      <Button type="submit" className="h-11">
        <Mail /> Open in email
      </Button>
    </form>
  );
}
