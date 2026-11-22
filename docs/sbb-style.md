# SBB look for apps built on sbb-twin

Every app that shows sbb-twin data (passenger app, station screen, staff tools, the twin's own control page) should
look like one product family, in the visual language of SBB. This page lists what the control page follows and the
conventions every app should share, with the values to copy. When an app needs something not covered here, take it
from the SBB design system first.

**Sources.** SBB design system *Lyne* ([digital.sbb.ch](https://digital.sbb.ch), tokens and components
`@sbb-esta/lyne-elements`), the SBB web fonts on `cdn.app.sbb.ch`, SBB's public timetable conventions and reason codes,
and swisstopo base maps. We use the visual language only: **no SBB logo, clock or pictograms**, and no claim to be an
official SBB product.

## 1. Principles

- White (or dark) calm surfaces, lots of space, greys for structure. **Red is for the one main action and for
  alerts**, never decoration.
- Colour always means the same thing in every app (section 4). Never encode a state by colour alone: add a word, a
  label or a shape.
- Flat: no gradients, no coloured side bars on cards, no emoji, no glow except on the map. Shadows only on floating
  panels.
- Sentence case everywhere ("Section closed", not "Section Closed"). Short verbs on buttons ("Provoke", "Sync all").

## 2. Type

| Use | Font | Weight | Size |
|---|---|---|---|
| Page title, brand | SBB Web | Bold 700 | 19 px |
| Section titles | SBB Web | Bold 700 | 16–18 px |
| Body, lists, inputs | SBB Web | Roman 400 | 14 px (base), 15 px in inputs |
| Secondary text, captions | SBB Web | Roman 400 | 12–13 px, colour `metal` |
| Big numbers (stats) | SBB Web | Bold 700 | as the line, numbers bold and the unit regular |
| Map labels | Frutiger Neue (base map font) | Bold | 10.5–13.5 px with a 2 px halo |

```css
@font-face { font-family: "SBB Web"; font-weight: 300; font-display: swap;
  src: url("https://cdn.app.sbb.ch/fonts/v1_6_subset/SBBWeb-Light.woff2") format("woff2"); }
@font-face { font-family: "SBB Web"; font-weight: 400; font-display: swap;
  src: url("https://cdn.app.sbb.ch/fonts/v1_6_subset/SBBWeb-Roman.woff2") format("woff2"); }
@font-face { font-family: "SBB Web"; font-weight: 700; font-display: swap;
  src: url("https://cdn.app.sbb.ch/fonts/v1_6_subset/SBBWeb-Bold.woff2") format("woff2"); }
body { font-family: "SBB Web", "Helvetica Neue", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
.time, .delay, .stat { font-variant-numeric: tabular-nums; }   /* times and counters do not jump */
```

## 3. Colours

SBB palette names. Light values are SBB's; dark values are ours (same roles, readable on dark surfaces).

| Token | Light | Dark | Role |
|---|---|---|---|
| `red` | `#eb0000` | `#eb0000` | main action, critical alert, closures, delays in text |
| `red125` | `#c60018` | `#c60018` | red hover/pressed |
| `charcoal` | `#212121` | `#f1f2f4` | text |
| `iron` | `#444444` | `#d2d6db` | strong secondary text, track lines on the map |
| `granite` | `#686868` | `#b9bec5` | icons |
| `metal` | `#767676` | `#a3a9b1` | secondary text, captions |
| `smoke` | `#8d8d8d` | `#7d848d` | disabled text, cancelled trains |
| `cement` | `#bdbdbd` | `#5a6069` | disabled controls, ended items, switch off |
| `silver` | `#dcdcdc` | `#3a3f46` | dividers |
| `cloud` | `#e5e5e5` | `#30343a` | borders of cards, inputs and list rows |
| `milk` | `#f6f6f6` | `#22252a` | subtle backgrounds (ended items, hover) |
| `white` | `#ffffff` | `#17191c` | page and card surface |
| `blue` | `#2d327d` | `#8f95e8` | information, a train at a station |
| `sky` | `#0079c7` | `#0079c7` | selection, focus, links |
| `green` | `#00973b` | `#00973b` | running normally, OK, "back to reality" (Sync all), switch on |
| `orange` | `#f27e00` | `#f27e00` | late, warnings, speed restrictions |

```css
:root {
  --red: #eb0000; --red125: #c60018; --charcoal: #212121; --iron: #444444; --granite: #686868; --metal: #767676;
  --smoke: #8d8d8d; --cement: #bdbdbd; --silver: #dcdcdc; --cloud: #e5e5e5; --milk: #f6f6f6; --white: #ffffff;
  --blue: #2d327d; --sky: #0079c7; --green: #00973b; --orange: #f27e00;
  color: var(--charcoal); background: var(--white);
}
:root[data-theme="dark"] {
  --white: #17191c; --milk: #22252a; --cloud: #30343a; --silver: #3a3f46; --cement: #5a6069; --smoke: #7d848d;
  --metal: #a3a9b1; --granite: #b9bec5; --iron: #d2d6db; --charcoal: #f1f2f4; --blue: #8f95e8; color-scheme: dark;
}
```

Roles on top of the palette (the control page uses them; values light / dark): `raised` (selected segment of a
switch) `#ffffff` / `#30343a`; `red-text` (delays and warnings as text, AA on dark) `#eb0000` / `#ff4d4d`; `map` (map
ground) `#fcfcfc` / `#1b1e22`; `scrim` (behind a pop-up) `rgba(33,33,33,.45)` / `rgba(0,0,0,.6)`; success box
`#e8f5ed` on `#005c24` / `rgba(0,151,59,.16)` on `#6fd69a`; floating shadows `rgba(0,0,0,.14)` / `rgba(0,0,0,.5)`.

Dark mode switches **the whole page and the map** together, never only one of them. Three choices: light, dark, like
the system (default); remembered in `localStorage` (`sbb-twin-theme`) and applied before the first paint. A switch
cross-fades page, map and trains together in 500 ms (ease-in-out cubic, MapLibre's curve), instantly with
`prefers-reduced-motion`. The map is recoloured with `setPaintProperty` transitions, never `setStyle`.

## 4. Meaning (identical in every app)

### Trains

A train's colour comes from what can be observed, in this order:

| State | Rule | Light | Dark / satellite |
|---|---|---|---|
| Cancelled | `motion = "cancelled"` / `status = "cancelled"` | `#8d8d8d` | `#a3a9b1` |
| Stopped on the open line | `motion = "stopped"` and `atStop = null` | `#eb0000` | `#eb0000` |
| Late | delay ≥ 3 min (`delaySec >= 180`) | `#f27e00` | `#f27e00` |
| Moving | `motion = "moving"` | `#00973b` | `#00973b` |
| At a station | `motion = "stopped"` at a stop | `#2d327d` | `#8f9cff` |
| Selected | the one the user picked | ring `#212121` + pulsing sky-blue ring | ring `#ffffff` |
| Simulated (staff only) | `truth/trains/{id}` exists | dashed ring around the marker | dashed ring |

**3 minutes** is SBB's punctuality threshold: a train counts as on time below 3 minutes late, so "late" starts at
`delaySec >= 180`. Shorter delays are still shown as numbers but not coloured.

### Times and delays

- Times as `HH:mm`, 24 h, `Europe/Zurich` (payloads are epoch milliseconds UTC).
- Delay after the planned time, in red, in whole minutes with a prime: `21:53 +2'`. No delay → nothing.
- Cancelled: the word "Cancelled" in red, the planned time struck through in `metal`.
- A skipped stop: "Does not stop" in `metal`.
- Durations in minutes ("120 min"), speeds in km/h.


### Incidents and disruptions

| Severity / effect | Colour | On the map |
|---|---|---|
| `critical`, section closed, obstacle, collision | `red` | the affected track drawn thick in red with a soft red glow |
| `major`, station closed | `red` | a red ring around the station |
| `minor`, speed restriction, signal failure | `orange` | the affected track thick in orange with a glow |
| `info` | `blue` | — |
| ended | `cement` / `smoke` | not drawn; listed greyed out for 30 minutes |

Titles follow SBB's wording: "Section closed: Thun – Spiez", "Limited service", "Delays possible". Causes use the SBB
reason texts ("Overhead line fault", "Track damage", "Person accident") with their reason codes (`EG_008` …).

## 5. Map

- Base map: swisstopo light base map (vector, `vectortiles.geo.admin.ch`); satellite: SWISSIMAGE. In dark mode the
  same base map is recoloured, not replaced (colours derived in OKLab: areas just below the dark ground, lines and
  labels light, relief toned down; layers whose colour depends on the feature are split per case so they can fade). Attribution "© swisstopo" (and "© OpenStreetMap contributors" when
  showing railways outside Switzerland).
- Keep the view on Switzerland (bounds `5.4, 45.55` – `11.0, 48.05`).
- Track: Swiss network `iron` 1–3.2 px with a white halo (dark: `#9aa6b8` with a dark halo; satellite: white with a
  dark halo); railways abroad a lighter grey.
- Stations: white dot with an `iron` ring; three tiers by trains per day (≥ 300 from zoom 6, 60–300 from zoom 9, the rest
  from zoom 11), names in bold.
- Trains: a triangle pointing in the direction of travel, white 1.5 px outline, colour from section 4; from zoom 10 a
  white pill label with the line ("IC8") and the delay in red ("+3'"). Render one second behind and interpolate.
- Click priority: trains, then the smallest event under the cursor, then stations.

## 6. Components

| Component | Spec |
|---|---|
| Primary button | pill (radius 999 px), 40 px high, `red` background, white bold text, `red125` on hover; one per view |
| Secondary button | pill, 1 px `charcoal` border, transparent; destructive variant with `red` border and text |
| "Back to reality" (Sync all) | pill, `green` background, white bold text |
| Chips (presets) | pill, 1 px `cloud` border; selected = `charcoal` fill, white text |
| Inputs and selects | 40 px high, radius 8 px, 1 px `cloud` border, 15 px text; focus = 2 px `sky` outline |
| Cards and panels | `white`, radius 10 px (lists) to 16 px (floating panels), 1 px `cloud` border; floating panels add `0 8px 24px rgba(0,0,0,.14)` |
| List rows | radius 10 px, 1 px `cloud` border, 10 × 12 px padding; an 8 px status dot before the title (red interrupted, orange limited, sky information, cement ended); the selected row gets a `sky` border |
| Switch | 44 × 26 px track, white 18 px knob; on = `green`, off = `cement` |
| Tabs | icon + label, `metal`; active = `charcoal` with a 2 px `red` underline |
| Header | white bar; brand mark = white train on a red square (radius 8 px); live stats in `metal` with bold numbers; a green dot for "Live" |
| Toast | `charcoal` background, white text, radius 10 px, bottom centre, 3–4 s |
| Empty states | one plain sentence in `metal` ("Nothing changed: every train follows the real data.") |

Spacing on a 4 px grid (4, 8, 12, 16, 24, 32). Hit areas at least 32 px.

## 7. Icons

SBB has its own line icon set (icons.app.sbb.ch). Where it is not available, use **one** line icon family with the
same feel; the control page uses [Lucide](https://lucide.dev) at 15–19 px, stroke 2, colour `granite` (or the text
colour inside buttons). Do not mix icon families.

## 8. Motion and accessibility

- Transitions 200–300 ms ease; base-map changes cross-fade in 600–700 ms; no bouncing or spinning.
- Text contrast at least 4.5 : 1 (the tokens above meet it on `white`).
- Keyboard focus always visible (2 px `sky` outline). Every icon-only button has a `title` and an `aria-label`.
- Respect `prefers-color-scheme` on first visit; remember the user's choice.
