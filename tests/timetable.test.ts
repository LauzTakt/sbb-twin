import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

test("the next service day maps trips to today's stations and skips trips with an unknown stop", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sbb-timetable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.RAIL_ENV_FILE = "";
  process.env.RAIL_DAYS_DIR = dir;
  const { loadDay, loadDayMapped, stationIndex } = await import("../src/timetable.ts");

  const bern = ["8507000", "Bern", 7.44, 46.95];
  const lausanne = ["8501120", "Lausanne", 6.63, 46.52];
  const calls = [0, 3600, 3630, 1, 7200, 7200];
  const today = { stops: [bern, lausanne], trips: [["20261122/.IR+1/05:00", "IR", "IR 1", "Lausanne", calls]] };
  const tomorrow = {
    stops: [lausanne, bern, ["new", "New stop", 7, 46]],
    trips: [
      ["20261123/.IR+1/05:00", "IR", "IR 1", "Bern", calls],
      ["20261123/.IR2", "IR", "IR 2", "New stop", [0, 3600, 3630, 2, 7200, 7200]],
    ],
  };
  await writeFile(join(dir, "day-2026-11-22.json.gz"), gzipSync(JSON.stringify(today)));
  await writeFile(join(dir, "day-2026-11-23.json.gz"), gzipSync(JSON.stringify(tomorrow)));

  const [current] = await loadDay("2026-11-22");
  assert.deepEqual([...current.stops], [0, 1]);
  assert.equal(current.trainId, "20261122_IR-1_05:00");
  assert.equal(current.line, "IR1");
  assert.equal(current.arr[0], Date.parse("2026-11-22T00:00:00Z"));
  assert.equal(current.dep[0] - current.arr[0], 30_000);

  const next = await loadDayMapped("2026-11-23");
  assert.equal(next.length, 1);
  assert.deepEqual([...next[0].stops], [1, 0]);
  assert.equal(next[0].trainId, "20261123_IR-1_05:00");
  assert.equal(next[0].arr[0] - current.arr[0], 86_400_000);
  assert.equal(stationIndex("8507000"), 0);
  assert.equal(stationIndex("new"), undefined);

  assert.deepEqual(await loadDayMapped("2026-11-24"), []);
  await assert.rejects(loadDay("2026-11-24"), /No timetable for 2026-11-24/);
});
