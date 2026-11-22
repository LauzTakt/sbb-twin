# Forecasts

The twin adds three forecasts to every disruption it knows about:

1. **How long will it last?** For a disruption that is still on: the chance it is still on in 1, 2 and 4 hours, the
   most likely end time, an 80 % window for the end, and whether SBB's announced end looks optimistic.
2. **Which trains to check after "Service resumed"?** When a disruption ends, every regular train due at its stations
   in the next hour gets a band: *check first*, *check* or *low*.
3. **Where do disruptions happen most?** A risk map of the network: 1,954 sections between stations, ranked by how many
   disruptions they can be expected to have per year.

Forecasts are advice for passengers, staff and the voice assistant. They never change the effective timetable or the
journey planner: those always follow what is officially running.

## Where to see them

| Where | What |
|---|---|
| **Forecasts** tab in the right panel (`/?tab=forecasts`) | one card per current disruption: SBB's announced end, the twin's expected end with its 80 % window, the chance it is still on at +1 h, +2 h and +4 h, and the trains to check after a resumption |
| **Risk map** button on the map (`/?risk=1`) | the section risk layer, in three tiers: the riskiest 5 %, the next 5 % (top 10 %) and the next 10 % (top 20 %) of sections |
| `/forecasts` | the evidence page: how each model was tested, with its scorecard, calibration and real examples, plus the live log |
| `GET /api/forecasts` | every current disruption with its forecast (JSON) |
| `GET /api/forecasts/post-resumption` | the trains to check after the resumptions of the last hour |
| `GET /api/forecasts/section-risk.geojson` | the risk map layer |
| `GET /api/forecasts/scorecards` | the test results of each model |
| `GET /api/forecasts/shadow` | the live log: each disruption's first forecast and, once it has ended, its score |
| MQTT `sbb-twin/v1/forecasts/disruptions` (retained) | the same payload as `GET /api/forecasts`, republished as it changes |
| MQTT `sbb-twin/v1/forecasts/post-resumption/{disruptionId}` (retained) | the trains to check after one resumption |

The live twin runs at <https://twin.latragallucci.dev>.

## How the models are built

All three models are trained offline in Python, in [`research/`](../research), on SBB's own records:

- **SBB's public disruption liveticker** (VIA), with every version of every message: 550 disruptions from March 2024 to
  October 2026, each with its cause code, its section, its announced end and the time SBB published "Service resumed".
- **SBB's operating records** (Ist-Daten), which show for every train and stop whether it ran as planned or was
  cancelled.
- **The twin's own network**: the BAV track geometry and the timetable the twin runs on.

Each model is fitted on March 2024 to December 2025, its settings are chosen on 2025, and it is then tested once on
January to October 2026, a period it never saw. The fitted models are plain JSON files
(`research/<model>/model.json`, the format is in [`research/forecast-contract.md`](../research/forecast-contract.md)).
The twin reads them in TypeScript, with no Python at runtime, and checks the files every minute, so a retrained model is
picked up without a restart. Every number in a model's `scorecard.json` comes from the script in the same folder and
re-runs in seconds:

```
/opt/venv/bin/python research/duration/duration.py
/opt/venv/bin/python research/post_resumption/post_resumption.py
/opt/venv/bin/python research/section_risk/section_risk.py
```

The twin recomputes all forecasts every 5 seconds and at once whenever a disruption is registered, changed or resumed
in the control console.

## 1. How long will it last?

### What it reads

Everything the model uses is known when the disruption is first announced:

| Input | Values |
|---|---|
| Cause | infrastructure (signal box, overhead line, track, power), rolling stock, a person (accident, people near the track, medical emergency), external (police, vandalism, obstacle, fallen tree, storm, flooding), planned works, other |
| Effect | interrupted, or limited / irregular |
| Scope | one station, or a section between stations |
| Announced end | SBB's announced end in minutes from the start, whether there is one, and whether it says "at least until" |
| Time | the hour the disruption started (night, morning peak, day, evening peak, evening) and weekend or weekday |

For real SBB alerts the twin reads the cause from the alert's cause field and from its text, matching 217 reason
phrases in German, French, Italian and English (for example "dérangement à un passage à niveau" or "guasto alla linea
di contatto"). The start is the alert's active period, otherwise the moment the twin first saw it. For disruptions registered in the
control console, the twin uses what was entered there.

### The model

The model is a survival model: it gives, for every time t, the probability S(t) that the disruption is still on t
minutes after it started. The logarithm of the duration follows a normal distribution whose centre moves with the
inputs:

```
ln(duration in minutes) ~ Normal(mu, sigma)
mu = intercept + sum of (coefficient x input)
S(t) = 1 - Phi((ln t - mu) / sigma)
```

A later announced end, an interruption rather than a limitation, or a night start move the centre later. The model was
fitted on the 380 disruptions that ended before 2026, with recent ones weighted more (half-life one year).

Once a disruption has been on for e minutes, only the futures in which it is still on count:

```
P(still on at t | still on now) = S(t) / S(e)
```

When SBB changes the announced end, the twin recomputes the inputs from the latest announcement, keeping the original
start.

### What it shows

| Output | How it is computed |
|---|---|
| Still disrupted in +1 h, +2 h, +4 h | `S(e + 60) / S(e)`, `S(e + 120) / S(e)`, `S(e + 240) / S(e)` |
| Expected end | SBB's announced end plus 27.5 minutes while that time is still ahead (the correction that gave the most accurate end times on 2025); after that, or without an announced end, the model's median end given the time already elapsed |
| 80 % window | the 10 % and 90 % quantiles of the end, given the time elapsed, widened by a calibration step fitted on 2025 (split conformal) so that it holds 80 % of disruptions |
| "Looks optimistic" | the chance it is still on at SBB's announced end is above 60 % |
| "Overdue" | SBB's announced end has passed and the disruption is still on |
| A sentence for the assistant | for example: "Disruptions like this usually last until about 10:30. It could also take several hours longer. The announced end at 10:00 looks optimistic." |

The model learned from unplanned disruptions that last hours, so two kinds of disruption get no duration forecast:
planned works announced over more than a day, for which the twin says "These are planned works until 12 Dec 04:00; the
announced end is usually kept.", and disruptions that have been on for more than two days. The Forecasts tab groups
them under *Planned works and long disruptions*. Shorter planned works keep their forecast, with the sentence "This is
planned work announced until 23:59; planned works usually end as announced."

### Example

At 09:50 on Sunday 22 November 2026, SBB's alert for Köniz – Schwarzenburg announced a limited service since 08:23
because of a level-crossing fault, until 10:00. The twin showed:

| Shown at 09:50 | Value |
|---|---|
| Announced end | 10:00 |
| Expected end | ≈ 10:30 |
| 80 % window | 09:50 to 15:15 |
| Still disrupted at 10:00 | 91 %, so the announced end looks optimistic |
| Still disrupted at 10:49, 11:49, 13:49 | 56 %, 32 %, 13 % |

### How it was tested

On the 140 disruptions of January to October 2026:

- The probabilities were scored with the Brier score (the mean squared gap between the forecast probability and what
  happened; lower is better) at 1, 2 and 4 hours. The model scored 0.146, 0.225 and 0.188, against 0.164, 0.235 and
  0.200 for SBB's own announced end turned into a probability, and 0.162, 0.257 and 0.225 for the historical rate.
- The 80 % window contained the real end of 79 % of the disruptions.
- The expected end time was off by 109 minutes on average, against 117 minutes for SBB's announced end.

## 2. Which trains to check after "Service resumed"?

### When it runs

When SBB publishes "Service resumed" for a section (a real SBB alert on a section is withdrawn), or when a disruption
registered in the twin is set to *Service resumed*, the twin lists the trains to check:

- regular trains only (no extra trains, no replacement buses);
- calling once at each station named in the disruption, with at most two hours between the two named stations;
- whose first named stop is within the hour after the notice (trains that had already left are not listed).

### The model

Each train gets one number: the minutes from the notice to its first scheduled stop at a named station (`lead`). The
risk that one of its named stops is still cancelled is a logistic curve, fitted on 1,997 trains of 2024 and 2025:

```
risk = sigmoid(-0.962943 - 1.635479 x lead / 60)
```

That gives 28 % for a train due right away, 20 % after 15 minutes, 14 % after 30 minutes, 10 % after 45 minutes and 7 %
after an hour. The twin shows a band rather than the percentage:

| Band | Risk | Trains it covers | Share of such trains that lost a stop in 2026 |
|---|---|---|---|
| **check first** | 25 % or more | due within about 5 minutes of the notice | 46 % |
| **check** | 12 % to 25 % | due 5 to 38 minutes after the notice | 22 % |
| **low** | below 12 % | due later in the hour | 12 % |

The list refreshes the trains' official status every 10 seconds: an official cancellation or skipped stop is shown as
such, and always takes precedence over the band. The list stays up until 5 minutes after the last listed train's last
named stop.

### Example

Sion to Sierre/Siders, 2 January 2026, "Service resumed" at 18:08. The R91 due at Sion at 18:11 was rated *check first*
(26 %), and it did lose its stop at Sierre/Siders. The IR90 due at Sion at 18:56 was rated *low* (9.5 %), and it served
both stops.

### How it was tested

The model was fitted on earlier years and tested on the next one: fitted on 2024 and tested on 1,043 trains of 2025,
then fitted on 2024–25 and tested on 769 trains of 2026. In both years its Brier score was lower than the base rate's
(0.12206 against 0.12607 in 2025, 0.15615 against 0.16492 in 2026), with 95 % intervals (bootstrap over whole weeks)
above zero. In 2026, trains rated *check first* lost a stop almost four times as often as trains rated *low*.

## 3. Where do disruptions happen most?

### The sections

The BAV track network is cut at every station served by a train, at every junction and at every track end: 1,954
sections, 4,933 km in all. Each disruption of the liveticker is placed on the sections between the stations it names
(along the shortest track path) and its weight is spread over them.

### The model

For each section, a Poisson regression estimates its disruptions per year from:

- its length in km;
- its traffic (trains per day);
- its share of single track;
- the disruptions on nearby sections (within about 20 km), which gives a rate to sections with no history of their own.

Each section's own history is then blended in with empirical Bayes shrinkage, so that a single past incident does not
put a section at the top of the list. The settings (the 20 km radius, the amount of shrinkage) were chosen on 2025.

### The map

`segments.geojson` holds the 1,954 sections in rank order, each with its name, length, risk (0 to 1), rank, expected
disruptions per year, trains per day, past disruptions and their main causes. The map draws the top three tiers in one
blue ramp, darker (brighter in dark mode) and wider for the riskier tiers, and the rest of the network as a thin line.
Clicking a section shows its numbers.

### How it was tested

Ranked on March 2024 to December 2025 and checked on the 140 disruptions of January to October 2026: the 10 % of sections
ranked riskiest drew 53 % of the 2026 disruptions, against 20 % for the 10 % busiest sections by trains per day and 20 %
for the 10 % longest. The top 20 % drew 75 %.

## The live log

For every disruption, the twin keeps its first forecast and, when the disruption ends, scores it against the real end:
the Brier score at each horizon, whether the end fell inside the 80 % window and the error of the expected end, next to
the same scores for SBB's announced end. The log
is on the evidence page (`/forecasts`) and at `GET /api/forecasts/shadow`, and it is saved next to the twin's state
file.

## Files

| File | Role |
|---|---|
| `research/forecast-contract.md` | the format of the model and scorecard files |
| `research/duration/` | duration model: script, `model.json`, `scorecard.json`, README |
| `research/post_resumption/` | trains after a resumption: script, `model.json`, `scorecard.json`, README |
| `research/section_risk/` | risk map: script, `segments.geojson`, `scorecard.json`, README |
| `src/forecastModels.ts` | loads the JSON models and reloads them when they change |
| `src/forecast.ts` | the live duration forecasts, the live log and the API payloads |
| `src/resumption.ts` | the trains to check after a resumption |
| `viewer/src/Forecasts.tsx`, `viewer/src/risk.ts` | the Forecasts tab and the risk map layer |
| `viewer/forecasts.html`, `viewer/src/forecasts/` | the evidence page |
