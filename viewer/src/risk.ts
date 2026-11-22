// The section risk map (GET /api/forecasts/section-risk.geojson): stretches of track ranked by the disruptions they
// concentrate. Drawn by tier of the ranking, the same cut as the out-of-time check (recall@top 5 / 10 / 20 %): one calm
// blue ramp, darker (light theme) or brighter (dark theme) for the higher tiers, and wider too, so it never relies on
// colour alone. Validated as an ordinal ramp against both map grounds (dataviz validator).
import type { Theme } from "./theme";

export type RiskSegment = { id: string; name: string; km?: number; risk: number; rank: number; tier: string; perYear?: number; trainsPerDay?: number; incidentsTrain?: number; incidentsTest?: number; topCauses?: string[] | string };
export const RISK = {
  steps: [
    { key: "top5", label: "Riskiest 5 % of sections" },
    { key: "top10", label: "Next 5 % (top 10 %)" },
    { key: "top20", label: "Next 10 % (top 20 %)" },
    { key: "rest", label: "Other sections" },
  ],
  light: { top5: "#0d366b", top10: "#1c5cab", top20: "#3987e5", rest: "#86b6ef" },
  dark: { top5: "#cde2fb", top10: "#86b6ef", top20: "#3987e5", rest: "#1c5cab" },
};
const tier = (values: Record<string, unknown>, fallback: unknown) => ["match", ["get", "tier"], "top5", values.top5, "top10", values.top10, "top20", values.top20, fallback];
export function riskPaint(theme: Theme) {
  const c = RISK[theme];
  return {
    "line-color": tier(c, c.rest),
    "line-width": ["interpolate", ["linear"], ["zoom"], 6, tier({ top5: 3.2, top10: 2.6, top20: 2 }, 1), 10, tier({ top5: 5, top10: 4, top20: 3.2 }, 1.6), 14, tier({ top5: 8, top10: 6.5, top20: 5 }, 2.5)],
    "line-opacity": ["match", ["get", "tier"], "rest", 0.75, 1],
  };
}
