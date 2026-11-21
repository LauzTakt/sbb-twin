// Swiss local time. GTFS times count from "noon minus 12 h" of the service day in Europe/Zurich.
const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const zone = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", timeZoneName: "shortOffset" });

export function zurich(ms: number) {
  const p = Object.fromEntries(parts.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
export function offsetMinutes(ms: number) {
  const name = zone.formatToParts(ms).find((x) => x.type === "timeZoneName")?.value ?? "GMT+1";
  const m = name.match(/GMT([+-]\d+)(?::(\d+))?/);
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] ?? 0) : 60;
}
/** Epoch ms of the GTFS time origin of a service date (YYYY-MM-DD). */
export function serviceOrigin(date: string) {
  const noon = Date.parse(`${date}T12:00:00Z`);
  return noon - offsetMinutes(noon) * 60_000 - 12 * 3_600_000;
}
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const compact = (date: string) => date.replaceAll("-", "");
