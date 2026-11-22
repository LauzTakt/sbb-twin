// Control-centre mode: register a disruption, decide what is done about it, see the bulletin it produces.
import { ArrowLeft, ArrowRight, BusFront, Check, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, send, type BusInfo, type Disruption } from "./feed";

type Cat = { code: string; label: string; effect: "interrupted" | "limited"; defaultMinutes: number | null; durationType: string; busShare?: number };
type Station = { id: string; name: string };
type Proposal = { measures?: { type: string; label?: string; probability?: number; at?: string }[]; note?: string };
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
  { id: "short_buses", title: "Short-turn the trains and order replacement buses", text: "Trains end at the last open station on each side. Buses are ordered, not timed: no bus runs until you confirm its times with the bus operator." },
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
  const [busWait, setBusWait] = useState<{ fromMin: number | null; toMin: number | null; n: number }>();
  useEffect(() => void api<{ expectedFirstBus: { fromMin: number | null; toMin: number | null; n: number } }>("/buses/evidence").then((e) => setBusWait(e.expectedFirstBus)).catch(() => undefined), []);
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
    plan === "short_buses" ? [{ type: "short_turn", at: "both" }, { type: "replacement_bus", sought: true }] : plan === "short" ? [{ type: "short_turn", at: "both" }] : plan === "hold" ? [{ type: "hold", maxWaitMin: 20 }] : plan === "limited" ? [{ type: "one_track_open", kmh: 40, cancelShare: 0.5 }] : [];
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
                    <small>{p.text}{p.id === "short_buses" && busWait?.fromMin != null ? ` In ${busWait.n} real incidents the first bus ran ${busWait.fromMin} to ${busWait.toMin} minutes after the start (the middle half).` : ""}</small>
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
          <p className="hint">You can change it later from the list on the right: confirm the buses once their times are known, reopen partly or end it.</p>
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
function Active({ disruptions, act }: { disruptions: Disruption[]; act: (path: string, body?: unknown, method?: "POST" | "DELETE") => Promise<unknown> | void }) {
  const list = disruptions.filter((d) => d.status === "active");
  if (!list.length) return <p className="hint">Nothing registered.</p>;
  return (
    <ul className="active">
      {list.map((d) => (
        <li key={d.id}>
          <b>{d.summary ?? d.label}</b>
          <span>{[d.cause?.label, d.endsAt ?? d.until ? `${d.durationType === "UNTIL_AT_LEAST" ? "at least " : ""}until ${hm(d.endsAt ?? d.until)}` : "end unknown", d.effect].filter(Boolean).join(" · ")}</span>
          {!!d.measures?.length && <small>Decisions: {d.measures.filter((m) => m.type !== "replacement_bus").map((m) => m.label ?? m.type).join(" · ") || "none besides buses"}</small>}
          <Buses d={d} act={act} />
          <div className="chips">
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

const busWindow = (w: BusInfo["expectedFirstBus"]) => (w && w.fromMin !== null ? `usually ${w.fromMin}-${w.toMin} min after the start` : w?.late ? "later than in almost every real incident" : "");
/** A disruption's replacement buses as the control centre handles them: order (no times), confirm with the operator's
 *  times (first departure, every N minutes or N buses), withdraw. */
export function Buses({ d, act }: { d: Disruption; act: (path: string, body?: unknown, method?: "POST" | "DELETE") => Promise<unknown> | void }) {
  const b = d.buses;
  const [form, setForm] = useState(false);
  const [first, setFirst] = useState("");
  const [by, setBy] = useState<"every" | "buses">("every");
  const [n, setN] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!b || !d.section?.b) return null; // a station disruption has no bus
  const A = d.section.a.name;
  const B = d.section.b.name;
  const num = Number(n);
  const cycle = b.cycleMin ?? 0;
  // what the operator's numbers mean on this route (a round trip on the road with a turnaround at each end)
  const preview = !n || !(num > 0) || !cycle ? "" : by === "every" ? `Every ${num} min needs ${Math.ceil(cycle / num)} bus${Math.ceil(cycle / num) === 1 ? "" : "es"} (a round trip takes ${cycle} min).` : `${num} bus${num === 1 ? "" : "es"} can run every ${Math.max(5, Math.ceil(cycle / num))} min (a round trip takes ${cycle} min).`;
  const confirm = async () => {
    if (!/^\d{1,2}:\d{2}$/.test(first)) return setErr("Give the first departure (HH:MM)");
    if (!(num > 0)) return setErr(by === "every" ? "Give the minutes between departures" : "Give the number of buses");
    setBusy(true);
    setErr("");
    try {
      await send("POST", `/disruptions/${d.id}/buses/confirm`, { firstAt: first, ...(by === "every" ? { everyMin: num } : { buses: num }) });
      setForm(false);
      setFirst("");
      setN("");
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  const via = (id: string) => b.stops.find((s) => s.id === id)?.busStop;
  const sa = via(d.section.a.id);
  const line =
    b.state === "requested"
      ? <><b>Buses: being organised</b>{busWindow(b.expectedFirstBus) && <> · {busWindow(b.expectedFirstBus)}{b.expectedFirstBus?.from ? ` (${hm(b.expectedFirstBus.from)}–${hm(b.expectedFirstBus.to)})` : ""}</>}</>
      : b.state === "confirmed"
        ? <><b>Buses: confirmed</b> · first {hm(b.firstDeparture?.A)} from {A}{b.firstDeparture && b.firstDeparture.B !== b.firstDeparture.A ? `, ${hm(b.firstDeparture.B)} from ${B}` : ` and ${B}`} · every {b.everyMin} min{b.buses ? ` · ${b.buses} bus${b.buses === 1 ? "" : "es"}` : ""}</>
        : b.state === "running"
          ? <><b>Buses: running</b> · every {b.everyMin} min · {b.vehicles} on the road{b.next?.A[0] ? ` · next from ${A} ${hm(b.next.A[0].departure)}` : ""}{b.next?.B[0] ? `, from ${B} ${hm(b.next.B[0].departure)}` : ""}</>
          : b.state === "withdrawn"
            ? <><b>Buses: withdrawn</b>{b.withdrawAt ? ` · no departures from ${hm(b.withdrawAt)}` : ""}</>
            : <><b>No replacement buses</b>{b.expectedFirstBus === null && b.evidence?.firstBusMin ? ` · if ordered, usually ${Math.round(b.evidence.firstBusMin.p25 / 5) * 5}-${Math.round(b.evidence.firstBusMin.p75 / 5) * 5} min after the start` : ""}</>;
  return (
    <div className={`buses ${b.state ?? "none"}`}>
      <p className="bus-state">
        <BusFront size={15} aria-hidden /> <span>{line}</span>
      </p>
      {(b.state === "confirmed" || b.state === "running") && sa && <small className="bus-stops">From the bus stops {sa.name} ({sa.walkMin} min walk){via(d.section.b.id) ? ` and ${via(d.section.b.id)!.name} (${via(d.section.b.id)!.walkMin} min)` : ""} · {b.runMin?.A} min on the road{b.road?.source === "osrm" ? "" : " (straight-line estimate)"}</small>}
      {form ? (
        <div className="bus-form">
          <label className="field">
            <span>First departure</span>
            <input type="time" value={first} onChange={(e) => setFirst(e.target.value)} aria-label="First departure" />
          </label>
          <div className="field">
            <span className="seg mini">
              <button type="button" aria-pressed={by === "every"} onClick={() => setBy("every")}>Every</button>
              <button type="button" aria-pressed={by === "buses"} onClick={() => setBy("buses")}>Buses</button>
            </span>
            <input type="number" min={by === "every" ? 5 : 1} max={by === "every" ? 240 : 60} value={n} placeholder={by === "every" ? "minutes" : "how many"} onChange={(e) => setN(e.target.value)} aria-label={by === "every" ? "Minutes between departures" : "Number of buses"} />
          </div>
          <div className="bus-actions">
            <button className="primary" disabled={busy} onClick={() => void confirm()}><Check size={14} /> Confirm</button>
            <button className="ghost" onClick={() => (setForm(false), setErr(""))}>Cancel</button>
          </div>
          {(preview || err) && <small className={err ? "hint warn" : "bus-preview"}>{err || preview}</small>}
        </div>
      ) : (
        <div className="chips">
          {(b.state === null || b.state === "withdrawn") && <button onClick={() => void act(`/disruptions/${d.id}/buses/request`)}>Order replacement buses</button>}
          {(b.state === "requested" || b.state === "confirmed") && <button className={b.state === "requested" ? "strong" : undefined} onClick={() => setForm(true)}>{b.state === "requested" ? "Confirm buses" : "Change times"}</button>}
          {b.state === "requested" && <button onClick={() => void act(`/disruptions/${d.id}/buses/withdraw`)}>No buses available</button>}
          {(b.state === "confirmed" || b.state === "running") && <button onClick={() => void act(`/disruptions/${d.id}/buses/withdraw`)}>Withdraw buses</button>}
        </div>
      )}
    </div>
  );
}
