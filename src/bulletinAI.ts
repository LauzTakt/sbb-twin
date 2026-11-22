// Bulletin wording by Claude Haiku, behind a safety net. The facts stay deterministic (src/scenario.ts renders them as
// the template text); the model only rewrites that text in SBB's style (and translates it to DE/FR/IT on request).
// Its answer is published only when it passes validate(): the same lines (\n structure), every line, station and time
// of the facts present, and nothing else (no other line names, stations, times, numbers or platforms). Any failure,
// a timeout or no key: the template text stands.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "./config.ts";
import { stops } from "./timetable.ts";

export type Lang = "en" | "de" | "fr" | "it";
export type BulletinFacts = {
  state: "interrupted" | "limited" | "resumed";
  section: { a: string; b: string | null };
  cause: string; // English cause clause
  durationType: string;
  until: string | null; // HH:MM
  lines: string[];
  noTrains: boolean;
  oneTrackKmh: number | null;
  replacementBus: "running" | "sought" | null;
  busStops: string[];
};
type Examples = Record<"interrupted" | "interrupted_bus" | "limited" | "resumed", Record<Lang, string>[]>;
const examples = JSON.parse(readFileSync(new URL("./bulletin-examples.json", import.meta.url), "utf8")) as Examples;
const LANG_NAME: Record<Lang, string> = { en: "English", de: "German", fr: "French", it: "Italian" };

export const aiEnabled = () => Boolean(config.anthropicKey);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s: string) => s.normalize("NFC");
const LINE_RE = /\b(?:ICE|ICN|IC|IRE|IR|EC|EN|NJ|RJX|TGV|RE|SN|S|R|PE)\s?\d{1,3}\b/g;
const PLATFORM_RE = /\b(?:platform|plattform|gleis\s*\d|perron|quai|voie\s*\d|binario\s*\d|marciapiede|sektor|sector)\b/i;

/** Why an answer cannot be published (empty list: it can). */
export function validate(text: string, facts: BulletinFacts, template: string): string[] {
  const errors: string[] = [];
  const t = fold(text.trim());
  if (!t) return ["empty"];
  if (t.split("\n").length !== template.split("\n").length) errors.push(`line structure: ${t.split("\n").length} lines, expected ${template.split("\n").length}`);
  for (const l of facts.lines) if (!new RegExp(`(^|[^A-Za-z0-9])${esc(l)}([^A-Za-z0-9]|$)`).test(t)) errors.push(`missing line ${l}`);
  const stations = [facts.section.a, facts.section.b, ...(facts.replacementBus === "running" ? facts.busStops : [])].filter(Boolean) as string[];
  for (const s of [facts.section.a, facts.section.b].filter(Boolean) as string[]) if (!t.includes(fold(s))) errors.push(`missing station ${s}`);
  if (facts.until && facts.durationType !== "UNKNOWN" && facts.state !== "resumed" && !t.includes(facts.until)) errors.push(`missing time ${facts.until}`);
  for (const m of t.match(/\b\d{1,2}[:.]\d{2}\b/g) ?? []) if (m.replace(".", ":") !== facts.until) errors.push(`invented time ${m}`);
  for (const m of t.match(LINE_RE) ?? []) {
    const l = m.replace(/\s/g, "");
    if (!facts.lines.includes(l)) errors.push(`invented line ${m}`);
  }
  const allowed = JSON.stringify(facts) + template;
  for (const n of t.match(/\d+/g) ?? []) if (!allowed.includes(n)) errors.push(`invented number ${n}`);
  if (PLATFORM_RE.test(t)) errors.push("mentions a platform");
  // a station of the network that is not in the facts
  const known = stations.map(fold);
  for (const s of stops) {
    if (s.name.length < 6 || known.some((k) => k.includes(s.name) || s.name.includes(k))) continue;
    if (t.includes(s.name) && new RegExp(`(^|[^\\p{L}])${esc(s.name)}([^\\p{L}]|$)`, "u").test(t)) {
      errors.push(`invented station ${s.name}`);
      break;
    }
  }
  return errors;
}

function prompt(facts: BulletinFacts, template: string, lang: Lang) {
  const kind = facts.state === "resumed" ? "resumed" : facts.state === "limited" ? "limited" : facts.replacementBus === "running" ? "interrupted_bus" : "interrupted";
  const shots = examples[kind].map((e, i) => `Example ${i + 1}:\n${e[lang]}`).join("\n\n");
  const system = [
    `You write the public text of an SBB rail disruption bulletin in ${LANG_NAME[lang]}, in the style of the real SBB examples.`,
    "Rewrite the draft so it reads like the examples. Keep exactly one output line per draft line, in the same order, each line saying what its draft line says.",
    "Use only the facts given. Keep every station name, line name and time exactly as written. Do not add stations, lines, times, numbers, platforms, routes, reasons or advice that are not in the facts.",
    "Answer with the bulletin text only: no title, no quotes, no comments.",
  ].join("\n");
  const user = `Real SBB bulletins of the same kind (${LANG_NAME[lang]}):\n\n${shots}\n\nFacts (JSON):\n${JSON.stringify(facts)}\n\nDraft (English, ${template.split("\n").length} lines):\n${template}`;
  return { system, user };
}

const cache = new Map<string, { text: string; source: "ai" | "template"; errors: string[] }>();
let calls = 0;
/** The bulletin text for these facts: Haiku's when it passes validation within the timeout, else the template. */
export async function writeBulletin(facts: BulletinFacts, template: string, lang: Lang = "en", timeoutMs = config.bulletinTimeoutMs): Promise<{ text: string; source: "ai" | "template"; errors: string[] }> {
  if (!config.anthropicKey) return { text: template, source: "template", errors: ["no key"] };
  const key = createHash("sha1").update(`${lang}|${template}|${JSON.stringify(facts)}`).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;
  const { system, user } = prompt(facts, template, lang);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let out: { text: string; source: "ai" | "template"; errors: string[] };
  try {
    calls++;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": config.anthropicKey, "anthropic-version": "2026-10-21" },
      body: JSON.stringify({ model: config.bulletinModel, max_tokens: 1024, thinking: { type: "disabled" }, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    if (body.stop_reason && body.stop_reason !== "end_turn") throw new Error(`stop ${body.stop_reason}`);
    const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim().replace(/\r/g, "").replace(/\n{2,}/g, "\n");
    const errors = validate(text, facts, template);
    out = errors.length ? { text: template, source: "template", errors } : { text, source: "ai", errors: [] };
  } catch (err) {
    out = { text: template, source: "template", errors: [ctl.signal.aborted ? "timeout" : (err as Error).message] };
  } finally {
    clearTimeout(timer);
  }
  if (out.source === "ai" || out.errors[0] !== "timeout") cache.set(key, out); // a timeout may succeed next time
  lastError = out.source === "template" ? out.errors.slice(0, 3).join("; ") : null;
  if (out.source === "template") console.warn(`[bulletin] ${lang} kept the template: ${out.errors.slice(0, 3).join("; ")}`);
  return out;
}
let lastError: string | null = null;
export const aiStats = () => ({ enabled: aiEnabled(), model: config.bulletinModel, calls, cached: cache.size, lastError });
