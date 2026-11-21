// Control-centre mode: register a disruption, decide what is done about it, see the bulletin it produces.
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, send, type Disruption } from "./feed";

type Cat = { code: string; label: string; effect: "interrupted" | "limited"; defaultMinutes: number | null; durationType: string; busShare?: number };
type Station = { id: string; name: string };
type Proposal = { measures?: { type: string; label?: string; probability?: number; at?: string }[]; note?: string };
const fold = (x: string) => x.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const hm = (ms?: number | null) => (ms ? new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }) : "");
const MEASURES: { type: string; label: string; body: Record<string, unknown> }[] = [
  { type: "short_turn", label: "Short-turn trains at both ends", body: { type: "short_turn", at: "both" } },
  { type: "replacement_bus", label: "Replacement buses every 15 min", body: { type: "replacement_bus", firstInMin: 15, everyMin: 15 } },
  { type: "hold", label: "Hold trains at the station before", body: { type: "hold" } },
];

let stationList: Promise<Station[]> | undefined;
const loadStations = () =>
  (stationList ??= api<{ features: { properties: { id: string; name: string; trains: number } }[] }>("/stations.geojson")
    .then((fc) => fc.features.sort((a, b) => b.properties.trains - a.properties.trains).map((f) => ({ id: f.properties.id, name: f.properties.name })))
    .catch(() => ((stationList = undefined), [])));

function Picker({ label, value, onChange }: { label: string; value?: Station; onChange: (s?: Station) => void }) {
  const [all, setAll] = useState<Station[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => void loadStations().then(setAll), []);
  const list = useMemo(() => (q ? all.filter((s) => fold(s.name).includes(fold(q))) : all).slice(0, 60), [all, q]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={open ? q : (value?.name ?? q)}
        placeholder="Search a station"
        onFocus={() => (setOpen(true), setQ(""))}
        onChange={(e) => (setQ(e.target.value), onChange(undefined))}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <ul className="picker">
          {list.map((s) => (
            <li key={s.id}>
              <button type="button" onMouseDown={() => (onChange(s), setQ(s.name), setOpen(false))}>{s.name}</button>
            </li>
          ))}
        </ul>
      )}
    </label>
  );
}

export function Control({ disruptions }: { disruptions: Disruption[] }) {
  const [supported, setSupported] = useState<boolean>();
  const [cats, setCats] = useState<Cat[]>([]);
  const [cause, setCause] = useState("");
  const [scope, setScope] = useState<"section" | "station">("section");
  const [from, setFrom] = useState<Station>();
  const [to, setTo] = useState<Station>();
  const [station, setStation] = useState<Station>();
  const [effect, setEffect] = useState<"interrupted" | "limited">("interrupted");
  const [endType, setEndType] = useState("UNTIL");
  const [time, setTime] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  useEffect(() => {
    void api<Cat[]>("/disruption-types")
      .then((c) => {
        const ok = Array.isArray(c) && c.length > 0 && "code" in c[0];
        setSupported(ok);
        if (ok) (setCats(c), setCause(c[0].code));
      })
      .catch(() => setSupported(false));
  }, []);
  const cat = cats.find((c) => c.code === cause);
  useEffect(() => {
    if (!cat) return;
    setEffect(cat.effect);
    setEndType(cat.durationType === "UNTIL_AT_LEAST" ? "UNTIL_AT_LEAST" : cat.durationType === "UNKNOWN" ? "UNKNOWN" : "UNTIL");
    const t = new Date(Date.now() + (cat.defaultMinutes ?? 120) * 60000);
    t.setMinutes(Math.ceil(t.getMinutes() / 5) * 5);
    setTime(t.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }));
  }, [cat]);
  if (supported === undefined) return <p className="hint">Loading…</p>;
  if (!supported) return <p className="hint">The control-centre engine of the twin is not switched on yet: it is still being built, so disruptions cannot be registered for now.</p>;
  const ready = scope === "section" ? from && to && from.id !== to.id : station;
  const minutes = () => {
    if (endType === "UNKNOWN" || !time) return null;
    const [h, m] = time.split(":").map(Number);
    const now = new Date();
    const zurich = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
    let d = h * 60 + m - (zurich.getHours() * 60 + zurich.getMinutes());
    if (d <= 0) d += 1440;
    return d;
  };
  const report = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const r = await send<{ disruption: Disruption; proposal?: Proposal }>("POST", "/disruptions", { cause, effect, scope: scope === "section" ? { kind: "section", from: from!.id, to: to!.id } : { kind: "station", station: station!.id }, minutes: minutes(), durationType: endType });
      if (r.proposal) setProposals((p) => ({ ...p, [r.disruption.id]: r.proposal! }));
      setMsg(`Registered: ${r.disruption.summary ?? r.disruption.label ?? "disruption"}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
  };
  const act = async (path: string, body?: unknown, method: "POST" | "DELETE" = "POST") => {
    try {
      await send(method, path, body);
      setMsg("Done");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <>
      <label className="field">
        <span>Cause</span>
        <select value={cause} onChange={(e) => setCause(e.target.value)}>
          {cats.map((c) => (
            <option key={c.code} value={c.code}>{c.label}</option>
          ))}
        </select>
      </label>
      <div className="seg">
        {(["section", "station"] as const).map((s) => (
          <button key={s} aria-pressed={scope === s} onClick={() => setScope(s)}>{s === "section" ? "Section" : "Station"}</button>
        ))}
      </div>
      {scope === "section" ? (
        <div className="row">
          <Picker label="From" value={from} onChange={setFrom} />
          <Picker label="To" value={to} onChange={setTo} />
        </div>
      ) : (
        <Picker label="Station" value={station} onChange={setStation} />
      )}
      <div className="seg">
        {(["interrupted", "limited"] as const).map((e) => (
          <button key={e} aria-pressed={effect === e} onClick={() => setEffect(e)}>{e === "interrupted" ? "Interrupted" : "Limited"}</button>
        ))}
      </div>
      <div className="row">
        <label className="field">
          <span>Expected end</span>
          <select value={endType} onChange={(e) => setEndType(e.target.value)}>
            <option value="UNTIL">Until approx.</option>
            <option value="UNTIL_AT_LEAST">At least until</option>
            <option value="UNKNOWN">Unknown</option>
          </select>
        </label>
        {endType !== "UNKNOWN" && (
          <label className="field">
            <span>Time</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        )}
      </div>
      <button className="primary wide" disabled={!ready || busy} onClick={() => void report()}>
        <Plus size={15} /> Report
      </button>
      {msg && <p className="hint">{msg}</p>}

      <h2 className="gap">Active</h2>
      {!disruptions.filter((d) => d.status === "active").length && <p className="hint">Nothing registered.</p>}
      <ul className="active">
        {disruptions.filter((d) => d.status === "active").map((d) => (
          <li key={d.id}>
            <b>{d.summary ?? d.label}</b>
            <span>{[d.cause?.label, d.endsAt ?? d.until ? `${d.durationType === "UNTIL_AT_LEAST" ? "at least " : ""}until ${hm(d.endsAt ?? d.until)}` : "end unknown", d.effect].filter(Boolean).join(" · ")}</span>
            {d.description && <p className="bulletin">{d.description}</p>}
            {!!d.measures?.length && <small>Decisions: {d.measures.map((m) => m.label ?? m.type).join(" · ")}</small>}
            {proposals[d.id]?.measures?.length ? (
              <div className="proposal">
                <small>Suggested{proposals[d.id].note ? `: ${proposals[d.id].note}` : ""}</small>
                {proposals[d.id].measures!.map((m) => (
                  <button key={m.type + (m.at ?? "")} onClick={() => void act(`/disruptions/${d.id}/measures`, m)}>
                    {m.label ?? m.type}{m.probability ? ` (${Math.round(m.probability * 100)}%)` : ""}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="chips">
              {MEASURES.map((m) => (
                <button key={m.type} onClick={() => void act(`/disruptions/${d.id}/measures`, m.body)}>{m.label}</button>
              ))}
              <button onClick={() => void act(`/disruptions/${d.id}/state`, { effect: d.effect === "limited" ? "interrupted" : "limited" })}>{d.effect === "limited" ? "Interrupted again" : "Partially reopened"}</button>
              <button className="strong" onClick={() => void act(`/disruptions/${d.id}/end`)}>Service resumed</button>
              <button onClick={() => void act(`/disruptions/${d.id}`, undefined, "DELETE")} aria-label="Remove"><X size={13} /></button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
