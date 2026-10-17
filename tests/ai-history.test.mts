// Chat with PDF: the conversation sent with each question must stay within
// what /api/ai/chat accepts, however long the chat or its answers get.
// Before, a long answer or a 21st question made every later request fail
// with "Invalid request.".
import { z } from "zod";
import { fitHistory, MAX_MESSAGE_CHARS, MAX_MESSAGES, type HistoryMessage } from "../lib/ai/history.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

// Same shape and limits as the route's body schema.
const messagesSchema = z
  .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(MAX_MESSAGE_CHARS) }))
  .min(1)
  .max(MAX_MESSAGES)
  .refine((m) => m[0].role === "user" && m[m.length - 1].role === "user");
const accepted = (m: HistoryMessage[]) => messagesSchema.safeParse(m).success;

const user = (content: string): HistoryMessage => ({ role: "user", content });
const assistant = (content: string): HistoryMessage => ({ role: "assistant", content });

// (a) A long answer (normal for 4000 answer tokens), then a follow-up.
const longAnswer = "Growth was strong. ".repeat(504); // 9576 chars
const followUp = [user("Give me a LONG summary"), assistant(longAnswer), user("And what about growth?")];
check("raw history with a long answer is rejected", !accepted(followUp));
const fitted = fitHistory(followUp);
check("fitted history with a long answer is accepted", accepted(fitted));
check("the long answer is cut to the limit", fitted[1].content.length === MAX_MESSAGE_CHARS);
check("the new question is kept", fitted.at(-1)!.content === "And what about growth?");

// (b) The 21st question makes 41 messages.
const chat: HistoryMessage[] = [];
for (let i = 1; i <= 20; i++) chat.push(user(`Question ${i}`), assistant(`Answer ${i}`));
chat.push(user("Question 21"));
check("raw 41-message history is rejected", !accepted(chat));
const recent = fitHistory(chat);
check("fitted 41-message history is accepted", accepted(recent), `${recent.length} messages`);
check("it keeps the newest turns", recent[0].content === "Question 2" && recent.at(-1)!.content === "Question 21");

// Trimming never leaves an answer first.
const odd = fitHistory([assistant("stray"), ...chat.slice(-40)]);
check("fitted history starts with a question", odd[0].role === "user" && accepted(odd));

// An answer that was stopped before any text is not sent as an empty message.
const stopped = fitHistory([user("One"), assistant(""), user("Two")]);
check("empty answers are dropped", accepted(stopped) && stopped.length === 2);

// A cut never splits an emoji in half.
const emoji = fitHistory([user("Hi"), assistant("a".repeat(MAX_MESSAGE_CHARS - 1) + "😀 tail"), user("Next")]);
check("cut keeps surrogate pairs whole", !/[\uD800-\uDBFF]$/.test(emoji[1].content) && accepted(emoji));

// Short chats go through unchanged.
const short = [user("Summarize"), assistant("It is a report."), user("Key dates?")];
check("short chats are unchanged", JSON.stringify(fitHistory(short)) === JSON.stringify(short));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat history checks passed.");
