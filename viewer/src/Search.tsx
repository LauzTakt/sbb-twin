// The console's search box: stations, lines in service, trains (by public number, line or destination) and the
// disruptions on the list. "/" focuses it, arrows move, Enter picks, Escape closes.
import { Search as SearchIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Item } from "./feed";

export type StationHit = { id: string; name: string; lon: number; lat: number; trains: number };
export type LineHit = { line: string; category: string; trains: number };
export type TrainHit = { trainId: string; line: string; category: string; number: string | null; headsign: string; delaySec: number; lat: number; lon: number };
type Results = { stations: StationHit[]; lines: LineHit[]; trains: TrainHit[] };
type Row = { key: string; group: string; label: string; sub: string; pick: () => void };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function Search(props: { items: Item[]; onStation: (s: StationHit) => void; onLine: (l: LineHit) => void; onTrain: (t: TrainHit) => void; onIssue: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Results>({ stations: [], lines: [], trains: [] });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // "/" anywhere (outside a field) focuses the box
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (!text) return setRes({ stations: [], lines: [], trains: [] });
    const n = ++seq.current;
    const timer = setTimeout(() => {
      void api<Results>(`/search?q=${encodeURIComponent(text)}`)
        .then((r) => n === seq.current && setRes(r))
        .catch(() => undefined);
    }, 120);
    return () => clearTimeout(timer);
  }, [q]);

  const rows = useMemo<Row[]>(() => {
    const text = fold(q.trim());
    const out: Row[] = [];
    for (const l of res.lines) out.push({ key: `l-${l.line}`, group: "Lines", label: l.line, sub: `${l.trains} ${l.trains === 1 ? "train" : "trains"} in service`, pick: () => props.onLine(l) });
    for (const t of res.trains) {
      const late = Math.round(t.delaySec / 60);
      out.push({ key: `t-${t.trainId}`, group: "Trains", label: `${t.line}${t.number ? ` ${t.number}` : ""} → ${t.headsign}`, sub: late > 0 ? `+${late} min` : "on time", pick: () => props.onTrain(t) });
    }
    for (const s of res.stations) out.push({ key: `s-${s.id}`, group: "Stations", label: s.name, sub: `${s.trains} trains today`, pick: () => props.onStation(s) });
    if (text.length >= 2)
      for (const i of props.items.filter((i) => fold(`${i.title} ${i.where}`).includes(text)).slice(0, 4))
        out.push({ key: `i-${i.id}`, group: "Disruptions", label: i.title, sub: i.where, pick: () => props.onIssue(i.id) });
    return out;
  }, [res, q, props]);

  useEffect(() => setActive(0), [rows.length]);

  const choose = (r: Row | undefined) => {
    if (!r) return;
    r.pick();
    setOpen(false);
    input.current?.blur();
  };
  const show = open && q.trim() !== "";
  let last = "";
  return (
    <div className="search" role="search">
      <SearchIcon size={15} className="search-icon" aria-hidden />
      <input
        ref={input}
        value={q}
        placeholder="Train, line or station   /"
        aria-label="Search a train, line, station or disruption"
        aria-expanded={show}
        aria-controls="search-results"
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, rows.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          else if (e.key === "Enter") choose(rows[active]);
          else if (e.key === "Escape") (setOpen(false), input.current?.blur());
        }}
      />
      {q && (
        <button className="search-clear" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={() => (setQ(""), input.current?.focus())}>
          <X size={14} />
        </button>
      )}
      {show && (
        <div className="search-results" id="search-results" role="listbox">
          {rows.length === 0 && <p className="search-empty">Nothing found for “{q.trim()}”</p>}
          {rows.map((r, i) => {
            const head = r.group !== last ? <h4 key={`h-${r.group}`}>{r.group}</h4> : null;
            last = r.group;
            return [
              head,
              <button key={r.key} role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(r)}>
                <span className="search-label">{r.label}</span>
                <span className="search-sub">{r.sub}</span>
              </button>,
            ];
          })}
        </div>
      )}
    </div>
  );
}
