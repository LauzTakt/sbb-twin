// Control-centre mode: register a disruption, decide what is done about it, see the bulletin it produces.
import { ArrowLeft, ArrowRight, Check, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, send, type Disruption } from "./feed";

type Cat = { code: string; label: string; effect: "interrupted" | "limited"; defaultMinutes: number | null; durationType: string; busShare?: number };
type Station = { id: string; name: string };
const fold = (x: string) => x.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const zurichDay = (ms: number) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
/** Epoch ms of a date and a time of day in Swiss time (summer or winter time as that day has it). */
function zurichEpoch(date: string, time: string) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", timeZoneName: "shortOffset" }).formatToParts(new Date(guess)).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const off = Number(part.replace("GMT", "").split(":")[0] || 0);
  return guess - off * 3600_000;
}
const hm = (ms?: number | null) => (ms ? new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }) : "");
type Plan = "short_buses" | "short" | "hold" | "limited" | "station";
const PLANS: { id: Plan; title: string; text: string }[] = [
  { id: "short_buses", title: "Short-turn the trains and run replacement buses", text: "Trains end at the last open station on each side. Buses run both ways every 15 minutes, first one in 15 minutes." },
  { id: "short", title: "Short-turn the trains", text: "Trains end at the last open station on each side. No buses." },
  { id: "hold", title: "Hold the trains until it reopens", text: "Trains wait at the station before the section. For short interruptions." },
  { id: "limited", title: "One track open", text: "Trains run through slowly and part of them is cancelled." },
  { id: "station", title: "Trains do not stop at the station", text: "Trains pass through without stopping while the station is closed." },
];
const duration = (min: number) => (min >= 60 ? `${Math.round((min / 60) * 2) / 2} h` : `${min} min`);

let stationList: Promise<Station[]> | undefined;
const loadStations = () =>
  (stationList ??= api<{ features: { properties: { id: string; name: string; trains: number } }[] }>("/stations.geojson")
    .then((fc) => fc.features.sort((a, b) => b.properties.trains - a.properties.trains).map((f) => ({ id: f.properties.id, name: f.properties.name })))
    .catch(() => ((stationList = undefined), [])));

function Picker({ label, value, onChange, only, hint }: { label: string; value?: Station; onChange: (s?: Station) => void; only?: Set<string>; hint?: string }) {
  const [all, setAll] = useState<Station[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => void loadStations().then(setAll), []);
  const list = useMemo(() => (q ? all.filter((s) => fold(s.name).includes(fold(q))) : all).filter((s) => !only || only.has(s.id)).slice(0, 80), [all, q, only]);
  return (
    <div className="field">
      <span>{label}</span>
      {value ? (
        <div className="chosen">
          <b>{value.name}</b>
          <button type="button" aria-label={`Clear ${label}`} onClick={() => (onChange(undefined), setQ(""))}>
            <X size={15} />
          </button>
        </div>
      ) : (
        <input value={q} placeholder="Search a station" onFocus={() => setOpen(true)} onChange={(e) => (setQ(e.target.value), setOpen(true))} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      )}
      {open && !value && (
        <ul className="picker">
          {!list.length && <li className="none">No connected station{q ? ` matches "${q}"` : ""}</li>}
          {list.map((s) => (
            <li key={s.id}>
              <button type="button" onMouseDown={() => (onChange(s), setQ(""), setOpen(false))}>{s.name}</button>
            </li>
          ))}
        </ul>
      )}
      {hint && !value && <small className="hint2">{hint}</small>}
    </div>
  );
}

export function Control({ disruptions, onClose }: { disruptions: Disruption[]; onClose: () => void }) {
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
  const [date, setDate] = useState(() => zurichDay(Date.now()));
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [plan, setPlan] = useState<Plan>("short_buses");
  const [fromOnly, setFromOnly] = useState<Set<string>>();
  const [toOnly, setToOnly] = useState<Set<string>>();
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ disruption: Disruption; bulletin?: { title: string; description: string } }>();
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
    setDate(zurichDay(t.getTime()));
    setTime(t.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }));
  }, [cat]);
  // once one end is chosen, the other can only be a station that trains connect it to (across the border too)
  useEffect(() => {
    if (!from) return setToOnly(undefined);
    void api<{ id: string }[]>(`/stations/${from.id}/neighbours?km=80`).then((n) => {
      const ids = new Set(n.map((x) => x.id));
      setToOnly(ids);
      setTo((t) => (t && !ids.has(t.id) ? undefined : t));
    }).catch(() => setToOnly(undefined));
  }, [from]);
  useEffect(() => {
    if (!to) return setFromOnly(undefined);
    void api<{ id: string }[]>(`/stations/${to.id}/neighbours?km=80`).then((n) => {
      const ids = new Set(n.map((x) => x.id));
      setFromOnly(ids);
      setFrom((f) => (f && !ids.has(f.id) ? undefined : f));
    }).catch(() => setFromOnly(undefined));
  }, [to]);
  if (supported === undefined) return <p className="hint">Loading…</p>;
  if (!supported) return <p className="hint">The control-centre engine of the twin is not switched on yet: it is still being built, so disruptions cannot be registered for now.</p>;
  const ready = scope === "section" ? from && to && from.id !== to.id : station;
  const endAt = () => (endType === "UNKNOWN" || !time || !date ? null : zurichEpoch(date, time));
  // what the control centre would most likely do: it is pre-selected, and the operator only confirms or picks another plan
  const suggest = (): Plan => {
    if (scope === "station") return "station";
    if (effect === "limited") return "limited";
    const end = endAt();
    const remaining = end === null ? null : (end - Date.now()) / 60000;
    if (remaining !== null && remaining <= 20) return "hold";
    return (cat?.busShare ?? 0) >= 0.5 ? "short_buses" : "short";
  };
  const next = () => {
    const end = endAt();
    if (end !== null && end <= Date.now()) return setMsg("The expected end is in the past");
    setMsg("");
    setPlan(suggest());
    setStep(2);
  };
  const measures = () =>
    plan === "short_buses" ? [{ type: "short_turn", at: "both" }, { type: "replacement_bus", firstInMin: 15, everyMin: 15 }] : plan === "short" ? [{ type: "short_turn", at: "both" }] : plan === "hold" ? [{ type: "hold", maxWaitMin: 20 }] : plan === "limited" ? [{ type: "one_track_open", kmh: 40, cancelShare: 0.5 }] : [];
  const register = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await send<{ disruption: Disruption; bulletin?: { title: string; description: string } }>("POST", "/disruptions", {
        cause, effect, scope: scope === "section" ? { kind: "section", from: from!.id, to: to!.id } : { kind: "station", station: station!.id }, until: endAt(), durationType: endType, measures: measures(),
      });
      setDone(r);
      setStep(3);
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
  };
  const act = async (path: string, body?: unknown, method: "POST" | "DELETE" = "POST") => {
    try {
      await send(method, path, body);
      setMsg("");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const reset = () => (setStep(1), setDone(undefined), setFrom(undefined), setTo(undefined), setStation(undefined), setMsg(""));
  return (
    <>
      <ol className="steps">
        {["Disruption", "Decisions", "Done"].map((n, i) => (
          <li key={n} className={step === i + 1 ? "on" : step > i + 1 ? "past" : ""}>
            <span>{step > i + 1 ? <Check size={13} /> : i + 1}</span>
            {n}
          </li>
        ))}
      </ol>

      {step === 1 && (
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
              <Picker label="From" value={from} onChange={setFrom} only={fromOnly} hint={to ? `Only stations connected to ${to.name}` : undefined} />
              <Picker label="To" value={to} onChange={setTo} only={toOnly} hint={from ? `Only stations connected to ${from.name}` : undefined} />
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
              <>
                <label className="field">
                  <span>Date</span>
                  <input type="date" value={date} min={zurichDay(Date.now())} onChange={(e) => setDate(e.target.value)} />
                </label>
                <label className="field">
                  <span>Time</span>
                  <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                </label>
              </>
            )}
          </div>
          {cat?.defaultMinutes && endType !== "UNKNOWN" && <p className="hint">Suggested end: now + {duration(cat.defaultMinutes)}, the usual length of this kind of disruption.</p>}
          {msg && <p className="hint warn">{msg}</p>}
          <button className="primary wide" disabled={!ready} onClick={next}>
            Next: decisions <ArrowRight size={15} />
          </button>
          {!!disruptions.filter((d) => d.status === "active").length && (
            <>
              <h2 className="gap">Registered in the twin</h2>
              <Active disruptions={disruptions} act={act} />
            </>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <p className="lead">What does the control centre decide? The most likely plan is selected: confirm it or pick another one.</p>
          <ul className="choices">
            {PLANS.filter((p) => (scope === "station" ? p.id === "station" : effect === "limited" ? p.id === "limited" : p.id !== "limited" && p.id !== "station")).map((p) => (
              <li key={p.id} className={plan === p.id ? "on" : ""}>
                <button type="button" className="choice" aria-pressed={plan === p.id} onClick={() => setPlan(p.id)}>
                  <span className="box round">{plan === p.id && <i />}</span>
                  <span className="txt">
                    <b>{p.title}{suggest() === p.id && <em>Suggested</em>}</b>
                    <small>{p.text}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {msg && <p className="hint warn">{msg}</p>}
          <div className="footer">
            <button className="ghost" onClick={() => setStep(1)}>
              <ArrowLeft size={15} /> Back
            </button>
            <button className="primary" disabled={busy} onClick={() => void register()}>
              <Plus size={15} /> Register disruption
            </button>
          </div>
        </>
      )}

      {step === 3 && done && (
        <>
          <div className="success">
            <Check size={18} /> Registered. The timetable, the map and the journey planner follow it now.
          </div>
          <h2 className="gap">Bulletin</h2>
          <p className="bulletin big"><b>{done.bulletin?.title ?? done.disruption.summary}</b>{"\n"}{done.bulletin?.description ?? done.disruption.description}</p>
          <p className="hint">You can change it later from the list on the right: add buses, reopen partly or end it.</p>
          <div className="footer">
            <button className="ghost" onClick={reset}>Register another</button>
            <button className="primary" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </>
  );
}

/** The disruptions registered in the twin, with the decisions that can still be taken while they last. */
function Active({ disruptions, act }: { disruptions: Disruption[]; act: (path: string, body?: unknown, method?: "POST" | "DELETE") => void }) {
  const list = disruptions.filter((d) => d.status === "active");
  if (!list.length) return <p className="hint">Nothing registered.</p>;
  return (
    <ul className="active">
      {list.map((d) => (
        <li key={d.id}>
          <b>{d.summary ?? d.label}</b>
          <span>{[d.cause?.label, d.endsAt ?? d.until ? `${d.durationType === "UNTIL_AT_LEAST" ? "at least " : ""}until ${hm(d.endsAt ?? d.until)}` : "end unknown", d.effect].filter(Boolean).join(" · ")}</span>
          {!!d.measures?.length && <small>Decisions: {d.measures.map((m) => m.label ?? m.type).join(" · ")}</small>}
          <div className="chips">
            <button onClick={() => void act(`/disruptions/${d.id}/measures`, { type: "replacement_bus", firstInMin: 15, everyMin: 15 })}>Add buses</button>
            <button onClick={() => void act(`/disruptions/${d.id}/measures`, { type: "short_turn", at: "both" })}>Short-turn trains</button>
            <button onClick={() => void act(`/disruptions/${d.id}/state`, { effect: d.effect === "limited" ? "interrupted" : "limited" })}>{d.effect === "limited" ? "Interrupted again" : "Partially reopened"}</button>
            <button className="strong" onClick={() => void act(`/disruptions/${d.id}/end`)}>Service resumed</button>
            <button onClick={() => void act(`/disruptions/${d.id}`, undefined, "DELETE")} aria-label="Remove"><X size={13} /></button>
          </div>
        </li>
      ))}
    </ul>
  );
}
