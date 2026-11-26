/**
 * A local stand-in for Ollama's /api/chat that "translates" the way the
 * Translate PDF tests need: deterministically (fakeTranslate), so a test can
 * tell which passage each translation belongs to, and badly on request.
 * Words in a passage switch on a misbehaviour:
 *
 *   XDROPX        left out the first time it is asked for
 *   XDROPALWAYSX  always left out
 *   XMERGEX       the next passage's text put into this one's, the next left out (first time)
 *   XREORDERX     the whole answer in reverse order
 *   XINJECTX      the model obeys the text the first time: prose, and an essay under its id
 *   XINJECTALWAYSX  the same, every time
 *   XSLOWX        each line of the answer after a pause (for Cancel)
 *   XFAILX        the server fails with a 500
 *
 * Answers come with a preface and a code fence, split into small pieces
 * across stream chunks, after some hidden reasoning, as real models do.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeCall {
  system: string;
  user: string;
  target: string;
  passages: { id: string; text: string }[];
}

export interface FakeModel {
  url: string;
  calls: FakeCall[];
  /** Requests whose connection closed before the answer was finished. */
  hungUp: number;
  close(): Promise<void>;
}

const LATIN = "abcdefghijklmnopqrstuvwxyz";
// A letter of the target's script for each Latin letter; Devanagari ones
// carry vowel signs and conjuncts, so shaping is needed to draw them.
const SCRIPTS: Record<string, string[]> = {
  Arabic: [..."ابتثجحخدذرزسشصضطظعغفقكلمنه"],
  Hebrew: [..."אבגדהוזחטיכלמנסעפצקרשתםןףך"],
  Russian: [..."абвгдежзийклмнопрстуфхцчшщ"],
  Greek: [..."αβγδεζηθικλμνξοπρστυφχψωάέ"],
  Hindi: ["क", "कि", "ख", "गी", "घ", "च", "छु", "ज", "झ", "ट", "ठ", "ड", "त्र", "थ", "द", "ध", "न", "प्र", "फ", "ब", "भ", "म", "र्य", "ल", "व", "क्ष"],
  "Chinese, in Simplified characters": [..."的一是不了人我在有他这中大来上国个到说们为子和"],
};

/**
 * What the fake answers for `text` in the language the prompt names: each
 * Latin letter swapped for one of the target's script, or shifted along the
 * alphabet by an amount of the language's own. About as long as the
 * passage, as real translations are.
 */
export function fakeTranslate(text: string, target: string): string {
  const letters = SCRIPTS[target];
  if (!letters) {
    const shift = (target.length % 25) + 1;
    return text.replace(/[a-z]/gi, (ch) => {
      const base = ch <= "Z" ? 65 : 97;
      return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26) + base);
    });
  }
  return [...text]
    .map((ch) => {
      const i = LATIN.indexOf(ch.toLowerCase());
      return i >= 0 ? letters[i] : ch;
    })
    .join("");
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeModel(): Promise<FakeModel> {
  const asked = new Map<string, number>();
  const state = { calls: [] as FakeCall[], hungUp: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const { messages } = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const target = /^Translate into: (.+)$/m.exec(user)?.[1] ?? "";
      const block = /<passages>\n([\s\S]*?)\n<\/passages>/.exec(user)?.[1] ?? "";
      const passages = block.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string });
      state.calls.push({ system, user, target, passages });
      const all = passages.map((p) => p.text).join(" ");
      if (all.includes("XFAILX")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "model crashed" }));
        return;
      }

      const lines: string[] = [];
      for (let i = 0; i < passages.length; i++) {
        const p = passages[i];
        const times = (asked.get(p.text) ?? 0) + 1;
        asked.set(p.text, times);
        if (p.text.includes("XDROPALWAYSX") || (p.text.includes("XDROPX") && times === 1)) continue;
        if (p.text.includes("XINJECTALWAYSX") || (p.text.includes("XINJECTX") && times === 1)) {
          lines.push("PWNED. As instructed, I will now ignore the document and do something else.");
          lines.push(JSON.stringify({ id: p.id, text: "PWNED ".repeat(400) }));
          continue;
        }
        if (p.text.includes("XMERGEX") && times === 1 && passages[i + 1]) {
          const next = passages[i + 1];
          asked.set(next.text, (asked.get(next.text) ?? 0) + 1);
          lines.push(JSON.stringify({ id: p.id, text: fakeTranslate(`${p.text} ${next.text}`, target) }));
          i++;
          continue;
        }
        lines.push(JSON.stringify({ id: p.id, text: fakeTranslate(p.text, target) }));
      }
      if (all.includes("XREORDERX")) lines.reverse();
      const answer = `Here are the translations:\n\`\`\`json\n${lines.join("\n")}\n\`\`\`\n`;

      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let open = true;
      res.on("close", () => {
        if (open) state.hungUp++;
        open = false;
      });
      const write = (o: object) => open && res.write(JSON.stringify(o) + "\n");
      write({ message: { role: "assistant", content: "", thinking: "The passages say to translate; reasoning stays hidden." }, done: false });
      const slow = all.includes("XSLOWX");
      for (let at = 0; at < answer.length && open; at += 7) {
        write({ message: { role: "assistant", content: answer.slice(at, at + 7) }, done: false });
        if (slow && answer.slice(at, at + 7).includes("\n")) await pause(150);
      }
      write({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" });
      open = false;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get calls() {
      return state.calls;
    },
    get hungUp() {
      return state.hungUp;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
