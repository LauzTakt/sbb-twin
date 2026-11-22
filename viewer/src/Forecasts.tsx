// The console's Forecasts tab: for every active disruption, the announced end against the predicted one, the chance it
// is still on in 1, 2 and 4 hours, and a flag when the announcement looks optimistic; after a resumption, the trains to
// check. Numbers from a placeholder model are marked as such and never shown as real.
import { ArrowUpRight, CircleAlert, Clock3, Construction, TrainFront } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./feed";
import type { DisruptionForecast, ForecastsResponse, Resumption } from "./forecastTypes";

const hm = (ms: number) => new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" });
const pct = (p: number) => `${Math.round(p * 100)} %`;
const hours = (min: number) => (min % 60 === 0 ? `+${min / 60} h` : `+${min} min`);
const since = (min: number) => (min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}` : `${Math.round(min / 1440)} days`);

export function useForecasts(every = 15_000) {
  const [data, setData] = useState<ForecastsResponse>();
  useEffect(() => {
    let alive = true;
    const load = () => void api<ForecastsResponse>("/forecasts").then((d) => alive && setData(d)).catch(() => undefined);
    load();
    const t = setInterval(load, every);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [every]);
  return data;
}

export function ForecastsPanel({ data, picked, onPick }: { data: ForecastsResponse | undefined; picked?: string; onPick: (id: string) => void }) {
  if (!data) return <p className="hint">Loading forecasts…</p>;
  const placeholder = data.models.duration.source !== "real";
  const live = data.disruptions.filter((f) => f.inScope && !f.planned);
  const planned = data.disruptions.filter((f) => !f.inScope || f.planned);
  return (
    <div className="fc">
      {placeholder && (
        <p className="fc-warn" role="note">
          <CircleAlert size={15} /> <span><b>Placeholder duration model.</b> The trained model has not landed yet: these numbers only test the screen, they are not forecasts.</span>
        </p>
      )}
      {!live.length && !data.resumed.length && <p className="hint">No unplanned disruption to forecast right now.</p>}
      <ul className="fc-list">
        {data.resumed.map((r) => (
          <li key={`r-${r.disruptionId}`}>
            <ResumedCard r={r} />
          </li>
        ))}
        {live.map((f) => (
          <li key={f.id} data-id={f.id} className={picked === f.id ? "picked" : undefined}>
            <ForecastCard f={f} onPick={() => onPick(f.id)} />
          </li>
        ))}
      </ul>
      {planned.length > 0 && (
        <details className="fc-planned">
          <summary>
            <Construction size={14} /> Planned works and long disruptions <b>{planned.length}</b>
          </summary>
          <p className="hint2">Planned works usually end as announced; disruptions on for days are outside what the model learned.</p>
          <ul>
            {planned.map((f) => (
              <li key={f.id}>
                <button className="linklike" onClick={() => onPick(f.id)}>{f.title}</button>
                <small>{f.announced.label ? `until ${f.announced.label}` : "no end announced"}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
      <a className="fc-more" href="/forecasts">
        How good are the forecasts? <ArrowUpRight size={15} />
      </a>
      <p className="fc-foot">
        Duration {data.models.duration.version} ({data.models.duration.source}) · after a resumption {data.models.post_resumption.version} ({data.models.post_resumption.source}). Advice only: forecasts never change the timetable or the planner.
      </p>
    </div>
  );
}

function ForecastCard({ f, onPick }: { f: DisruptionForecast; onPick: () => void }) {
  const dot = f.effect === "interrupted" ? "#eb0000" : "#f27e00";
  return (
    <article className={`fc-card${f.placeholder ? " ph" : ""}`}>
      <button className="fc-head" onClick={onPick}>
        <b style={{ ["--dot" as string]: dot }}>{f.title}</b>
        <small>
          {[f.cause.label && f.cause.group !== "other" ? f.cause.label[0].toUpperCase() + f.cause.label.slice(1) : null, `since ${f.startLabel}`, `${since(f.elapsedMin)} ago`].filter(Boolean).join(" · ")}
        </small>
      </button>
      <div className="fc-times">
        <div>
          <small>Announced end</small>
          <b>{f.announced.label ?? "none"}</b>
          <span>{f.announced.qualifier === "at_least" ? "at least" : f.announced.qualifier === "none" ? "no end given" : "by the operator"}</span>
        </div>
        <div className="pred">
          <small>Predicted end {f.placeholder && <em className="ph-tag">placeholder</em>}</small>
          <b>{f.median ? `≈ ${f.median.label}` : "–"}</b>
          <span>{f.band ? `${Math.round(f.band.level * 100)} %: ${f.band.lowLabel}–${f.band.highLabel}` : ""}</span>
        </div>
      </div>
      {(f.optimistic || f.overdue) && (
        <p className="fc-flag">
          <Clock3 size={14} />
          {f.optimistic ? `Announcement looks optimistic: ${pct(f.pAtAnnounced ?? 0)} chance it is still on at ${f.announced.label}` : `Past the announced end (${f.announced.label}) and still on`}
        </p>
      )}
      <div className="fc-bars" role="table" aria-label="Chance it is still disrupted">
        <div className="fc-bars-head" role="row"><span role="columnheader">Still disrupted in</span></div>
        {f.horizons.map((h) => (
          <div className="fc-bar" role="row" key={h.minutes} title={`${pct(h.p)} chance it is still disrupted at ${h.label}`}>
            <span role="cell" className="when">{hours(h.minutes)} <i>{h.label}</i></span>
            <span role="cell" className="track"><span className="fill" style={{ width: `${Math.max(2, h.p * 100)}%` }} /></span>
            <span role="cell" className="val">{pct(h.p)}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

/** After "Service resumed": the regular trains due at its stations in the next hour, as bands with the share of such
 *  trains that really lost a stop (not the model's percentages: it under-predicts the first quarter hour). */
export function ResumedCard({ r }: { r: Resumption }) {
  const [all, setAll] = useState(false);
  const ends = r.endpoints.map((e) => e.name).join(" or ");
  const shown = all ? r.trains : r.trains.slice(0, 6);
  const shares = r.bands.filter((b) => b.observed !== null);
  return (
    <section className="resume" aria-label="Trains to check after the resumption">
      <h4>
        <TrainFront size={14} /> Service resumed {r.where ? `· ${r.where}` : ""} at {hm(r.resumedAt)}
      </h4>
      <p className="sub2">Trains to check in the next hour{r.placeholder ? " (placeholder model)" : ""}</p>
      {r.trains.length ? (
        <ol>
          {shown.map((t) => (
            <li key={t.trainId} className={t.officialStatus !== "scheduled" ? "official" : undefined}>
              <time>{hm(t.plannedTime)}</time>
              <span className="who">
                <span className="name"><strong>{t.line}</strong> {t.headsign}</span>
                <small>at {t.station.name}</small>
              </span>
              {t.officialStatus !== "scheduled" ? (
                <em className="band off">{t.officialStatus === "cancelled" ? "cancelled" : "no stop"}</em>
              ) : (
                <em className={`band ${t.band === "check first" ? "first" : t.band === "check" ? "check" : "low"}`} title={t.bandObserved !== null ? `${Math.round(t.bandObserved * 100)} % of such trains lost a stop in 2026` : undefined}>
                  {t.band}
                </em>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="none">No regular train is due at {ends} in the next hour.</p>
      )}
      {r.trains.length > shown.length && (
        <button className="linklike more" onClick={() => setAll(true)}>
          Show all {r.trains.length} trains
        </button>
      )}
      {shares.length > 0 && (
        <p className="basis">
          In 2026, {shares.map((b) => `${Math.round((b.observed ?? 0) * 100)} % of "${b.label}" trains`).join(", ")} still lost a stop. An official cancellation always wins.
        </p>
      )}
    </section>
  );
}
