import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ForecastsResponse } from "../src/contracts/forecasts.ts";

// Each test file runs in its own process. Use the bundled timetable and models.
process.env.RAIL_ENV_FILE = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RAIL_DAYS_DIR = fileURLToPath(new URL("../data/days/", import.meta.url));
process.env.RAIL_RESEARCH_DIR = fileURLToPath(new URL("../research/", import.meta.url));
const { api } = await import("../src/api.ts");

test("read routes keep their /api paths and share the input-error handler", async () => {
  const app = api();
  assert.deepEqual(await (await app.request("/api/search")).json(), { stations: [], lines: [], trains: [] });
  const plan = await app.request("/api/plan");
  assert.equal(plan.status, 422);
  assert.deepEqual(await plan.json(), { error: "from and to are required (station id or name)" });
  const unknown = await app.request("/api/forecasts/post-resumption?disruptionId=missing");
  assert.equal(unknown.status, 404);
});

test("registering and ending a scenario refreshes the public forecast before the next request", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-22T09:00:00Z"));
  const { loadDay } = await import("../src/timetable.ts");
  await loadDay("2026-11-22");
  const app = api();
  const response = await app.request("/api/disruptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cause: "EG_008", scope: { kind: "station", station: "8507000" }, minutes: 90 }),
  });
  assert.equal(response.status, 201);
  const { disruption } = await response.json();
  const forecasts = async (): Promise<ForecastsResponse> => (await app.request("/api/forecasts")).json();
  const current = await forecasts();
  assert.equal(current.disruptions.length, 1);
  assert.equal(current.disruptions[0].id, disruption.id);
  assert.deepEqual(current.disruptions[0].horizons.map((h) => h.minutes), [60, 120, 240]);

  const ended = await app.request(`/api/disruptions/${disruption.id}/end`, { method: "POST" });
  assert.equal(ended.status, 200);
  assert.equal((await forecasts()).disruptions.length, 0);
});

test("train actions accept both legacy breakdown names and validate scope and train identity", async () => {
  const { createTrainDisruption, disruptions, InputError } = await import("../src/disruptions.ts");
  const scope = { kind: "train", trainId: "IR1" } as const;
  const label = (id: string) => id === "IR1" ? "IR1 → Bern" : undefined;
  for (const type of ["breakdown", "rolling_stock_failure", "emergency_brake", "cancellation"]) {
    const action = createTrainDisruption({ type, scope, minutes: 3, params: { brakeMs2: 1.2 } }, label);
    assert.equal(action.type, type === "cancellation" ? "cancellation" : "breakdown");
    assert.equal(action.where, "IR1 → Bern");
    assert.equal(action.endsAt! - action.startedAt, 180_000);
    assert.deepEqual(action.params, { brakeMs2: 1.2 });
    disruptions.delete(action.id);
  }
  assert.throws(() => createTrainDisruption({ type: "breakdown", scope: { kind: "station", station: "Bern" } }, label), InputError);
  assert.throws(() => createTrainDisruption({ type: "cancellation", scope: { ...scope, trainId: "missing" } }, label), InputError);
});
