/**
 * What one chat request may carry. The API route rejects anything larger, so
 * the browser trims the conversation with fitHistory() before sending it.
 */
export const MAX_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 8000;

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The newest part of a conversation that fits one request: at most
 * MAX_MESSAGES messages, starting with a question, with long answers cut to
 * MAX_MESSAGE_CHARS. The caller keeps the new question within that limit.
 */
export function fitHistory(messages: HistoryMessage[]): HistoryMessage[] {
  let kept = messages.filter((m) => m.content).slice(-MAX_MESSAGES);
  const firstQuestion = kept.findIndex((m) => m.role === "user");
  if (firstQuestion > 0) kept = kept.slice(firstQuestion);
  return kept.map((m) => {
    if (m.content.length <= MAX_MESSAGE_CHARS) return m;
    let end = MAX_MESSAGE_CHARS;
    // Don't leave half of a surrogate pair at the end.
    if (/[\uD800-\uDBFF]/.test(m.content[end - 1])) end--;
    return { role: m.role, content: m.content.slice(0, end) };
  });
}
