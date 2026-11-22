package ch.lauzhack.twin

/** Scripted replays of real disruptions (src/replay.ts): the control centre's decisions at their real times. */
class ReplayCtx { var d: Disruption? = null; val m = HashMap<String, String>() }
class ReplayStep(val at: String, val note: String, val run: (ReplayCtx, Long) -> Unit)
class Replay(val title: String, val date: String, val source: String, val steps: List<ReplayStep>)

private fun need(ctx: ReplayCtx) = ctx.d ?: throw RuntimeException("replay: no disruption yet")
private fun measure(key: String?, input: Map<String, Any?>): (ReplayCtx, Long) -> Unit = { ctx, now ->
    val m = addMeasure(need(ctx), input, now)
    if (key != null) ctx.m[key] = m.id
}
private fun withdraw(key: String, at: String, replaced: Boolean = false): (ReplayCtx, Long) -> Unit = { ctx, now -> withdrawMeasure(need(ctx), ctx.m[key]!!, at, now, replaced) }

private const val W = "8503206"
private const val P = "8503209"

val REPLAYS: Map<String, Replay> = mapOf(
    "waedenswil-2026-09-10" to Replay(
        "Overhead line fault Wädenswil - Pfäffikon SZ, 10 September 2026", "2026-09-10",
        "VIA incident 2195005182293 (12 versions) and its 27 TCC messages, extern-liveticker export",
        listOf(
            ReplayStep("05:43", "VIA: interrupted, overhead line fault, end unknown") { ctx, now -> ctx.d = createScenario(mapOf("cause" to "EG_008", "scope" to mapOf("kind" to "section", "from" to W, "to" to P), "effect" to "interrupted", "durationType" to "UNKNOWN"), now) },
            ReplayStep("06:54", "TCC: replacement buses are being sought", measure("sought", mapOf("type" to "replacement_bus", "sought" to true))),
            ReplayStep("06:56", "TCC: long-distance trains diverted (the twin turns them back before the section)", measure("turn", mapOf("type" to "short_turn", "at" to "both"))),
            ReplayStep("06:58", "TCC: S2, S8 and S25 cancelled between Wädenswil and Pfäffikon SZ", measure("cancel1", mapOf("type" to "cancel_lines", "lines" to listOf("S2", "S8", "S25")))),
            ReplayStep("07:13", "TCC: shuttle bus, Wädenswil at :10, Pfäffikon SZ at :40") { ctx, now ->
                withdraw("sought", "07:13", true)(ctx, now)
                measure("bus1", mapOf("type" to "replacement_bus", "minutesA" to listOf(10), "minutesB" to listOf(40)))(ctx, now)
            },
            ReplayStep("07:17", "VIA: at least until 12:00", measure(null, mapOf("type" to "prognosis", "until" to "12:00", "durationType" to "UNTIL_AT_LEAST"))),
            ReplayStep("08:32", "TCC: new bus times, Wädenswil :15 and :50, Pfäffikon SZ :22 and :42") { ctx, now ->
                withdraw("bus1", "08:32", true)(ctx, now)
                measure("bus2", mapOf("type" to "replacement_bus", "minutesA" to listOf(15, 50), "minutesB" to listOf(22, 42)))(ctx, now)
            },
            ReplayStep("10:35", "VIA: at least until 11:00", measure(null, mapOf("type" to "prognosis", "until" to "11:00", "durationType" to "UNTIL_AT_LEAST"))),
            ReplayStep("10:53", "VIA: limited service from 11:00, at least until 19:00") { ctx, now ->
                measure(null, mapOf("type" to "prognosis", "until" to "19:00", "durationType" to "UNTIL_AT_LEAST"))(ctx, now)
                measure(null, mapOf("type" to "partial_resumption", "at" to "11:00", "kmh" to 80))(ctx, now)
            },
            ReplayStep("10:55", "TCC: from 11:00 S2, S25 and IC3 stay cancelled, the S8 and IR35 run; no more buses from 11:00") { ctx, now ->
                withdraw("cancel1", "11:00", true)(ctx, now)
                withdraw("turn", "11:00", true)(ctx, now)
                measure(null, mapOf("type" to "cancel_lines", "lines" to listOf("IC3", "S2", "S25"), "at" to "11:00"))(ctx, now)
                withdraw("bus2", "11:00")(ctx, now)
            },
            ReplayStep("14:19", "VIA: at least until 16:00", measure(null, mapOf("type" to "prognosis", "until" to "16:00", "durationType" to "UNTIL_AT_LEAST"))),
            ReplayStep("15:23", "VIA: service resumed", measure(null, mapOf("type" to "resume"))),
        ),
    ),
)

private class LogEntry(val at: Long, val note: String, val error: String? = null) : JsonLike {
    override fun toJson() = obj("at" to at, "note" to note, "error" to (error ?: Undefined))
}
private class Active(val name: String, val replay: Replay, var next: Int, val ctx: ReplayCtx, val log: MutableList<LogEntry>)
private var active: Active? = null

/** Start a replay: its steps run as the clock reaches their times (those already due run at once). */
fun startReplay(name: String): Map<String, Any?> {
    val replay = REPLAYS[name] ?: throw InputError("Unknown replay \"$name\" (${REPLAYS.keys.joinToString(", ")})")
    if (zurich(Clock.now()).date != replay.date) throw InputError("This replay needs the twin's clock on ${replay.date} (RAIL_REPLAY=${replay.date}T05:30)")
    active = Active(name, replay, 0, ReplayCtx(), ArrayList())
    replayTick(Clock.now())
    return replayStatus()
}

/** Run the steps that are due (each at its own time). */
fun replayTick(t: Long) {
    val a = active ?: return
    var ran = false
    while (a.next < a.replay.steps.size) {
        val step = a.replay.steps[a.next]
        val at = parseTime(step.at, t)
        if (at > t) break
        a.next++
        try {
            step.run(a.ctx, at)
            a.log.add(LogEntry(at, step.note))
            println("[replay] ${step.at} ${step.note}")
        } catch (err: Exception) {
            a.log.add(LogEntry(at, step.note, err.message))
            System.err.println("[replay] ${step.at} failed: ${err.message}")
        }
        ran = true
    }
    if (ran) scenarioTick(t, true)
}

fun replayStatus(): Map<String, Any?> {
    val a = active ?: return obj("active" to null, "available" to REPLAYS.map { (n, r) -> obj("name" to n, "title" to r.title, "date" to r.date, "source" to r.source) })
    val d = a.ctx.d?.let { disruptions[it.id] }
    return obj(
        "active" to a.name, "title" to a.replay.title, "source" to a.replay.source, "disruptionId" to d?.id, "done" to a.log,
        "upcoming" to a.replay.steps.drop(a.next).map { obj("at" to it.at, "note" to it.note) },
    )
}

// ---------------------------------------------------------------- what the twin did (to score against Ist-Daten)
private val outcomes = LinkedHashMap<String, Map<String, Any?>>()
private fun n0(x: Double): Long? = if (x.isFinite()) jsRoundL(x) else null
private fun outcomeOf(tr: Train): Map<String, Any?>? {
    val d = active?.ctx?.d ?: return null
    val sc = d.scenario ?: return null
    val ids = (listOfNotNull(sc.a, sc.b) + sc.inside).toSet()
    val n = tr.trip.stops.size
    val idx = tr.trip.stops.mapIndexed { i, k -> k to i }.filter { (k, _) -> ids.contains(stops[k].id) }
    if (idx.size < 2) return null
    val last = liveTimes(tr.trip, Clock.now()).lastServed
    return obj(
        "trainId" to tr.trip.trainId, "line" to tr.trip.line, "category" to tr.trip.cat, "headsign" to tr.trip.head,
        "calls" to idx.map { (k, i) -> obj("id" to stops[k].id, "plannedArr" to (if (i > 0) tr.trip.arr[i] else null), "plannedDep" to (if (i < n - 1) tr.trip.dep[i] else null), "actualArr" to n0(tr.actArr[i]), "actualDep" to n0(tr.actDep[i]), "served" to (!tr.cancelled && i <= last)) },
        "terminatedAt" to tr.terminatedAt, "cancelled" to tr.cancelled,
    )
}
/** Keep what trains through the replayed section did when they leave service. */
fun recordRemoved(removed: List<Train>) {
    if (active == null) return
    for (tr in removed) outcomeOf(tr)?.let { outcomes[it["trainId"] as String] = it }
}
fun replayOutcome(): List<Map<String, Any?>> {
    val now = trains.values.mapNotNull { outcomeOf(it) }
    return outcomes.values.toList() + now.filter { !outcomes.containsKey(it["trainId"]) }
}
