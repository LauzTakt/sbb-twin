package ch.lauzhack.twin

import java.util.UUID

/** Disruptions provoked deliberately (ground truth) and incidents marked (public flags), src/disruptions.ts. */
class DisruptionType(val id: String, val label: String, val reasonCode: String, val effect: String, val scope: String, val defaultMinutes: Int?, val params: Map<String, Any?>?, val behaviour: String) : JsonLike {
    override fun toJson() = obj("id" to id, "label" to label, "reasonCode" to reasonCode, "effect" to effect, "scope" to scope, "defaultMinutes" to defaultMinutes, "params" to (params ?: Undefined), "behaviour" to behaviour)
}

val TYPES = listOf(
    DisruptionType("breakdown", "Train breakdown", "EG_014", "train_breakdown", "train", null, null, "The train stops where it is. Its section becomes an interrupted disruption (train blocking the line), with a bulletin; both end when the train is released."),
    DisruptionType("cancellation", "Train cancelled", "EG_063", "cancellation", "train", null, null, "The train ends its run at the next station and leaves service."),
)
private val ALIASES = mapOf("rolling_stock_failure" to "breakdown", "emergency_brake" to "breakdown")

/** kind: section | station | train | area | line | network */
class Scope(val kind: String, val from: String? = null, val to: String? = null, val station: String? = null, val trainId: String? = null, val lat: Double? = null, val lon: Double? = null, val radiusKm: Double? = null, val line: String? = null) : JsonLike {
    override fun toJson() = obj("kind" to kind, "from" to (from ?: Undefined), "to" to (to ?: Undefined), "station" to (station ?: Undefined), "trainId" to (trainId ?: Undefined), "lat" to (lat ?: Undefined), "lon" to (lon ?: Undefined), "radiusKm" to (radiusKm ?: Undefined), "line" to (line ?: Undefined))
    companion object {
        fun fromMap(m: Map<String, Any?>?): Scope? {
            m ?: return null
            val kind = m["kind"] as? String ?: return null
            return Scope(kind, m["from"] as? String, m["to"] as? String, m["station"] as? String, m["trainId"] as? String, m["lat"].asDouble(), m["lon"].asDouble(), m["radiusKm"].asDouble(), m["line"] as? String)
        }
    }
}

class BulletinMessage(val ts: Long, val title: String, val text: String) : JsonLike {
    override fun toJson() = obj("ts" to ts, "title" to title, "text" to text)
}

class Bulletin(
    val id: String, val version: Int, val ts: Long, val lang: String, val lifecycle: String, val title: String, val description: String,
    val lines: List<String>, val messages: List<BulletinMessage>, val source: String, val template: String? = null,
) : JsonLike {
    fun copy(version: Int = this.version, ts: Long = this.ts, description: String = this.description, source: String = this.source, lang: String = this.lang, title: String = this.title) =
        Bulletin(id, version, ts, lang, lifecycle, title, description, lines, messages, source, template)
    override fun toJson() = obj("id" to id, "version" to version, "ts" to ts, "lang" to lang, "lifecycle" to lifecycle, "title" to title, "description" to description, "lines" to lines, "messages" to messages, "source" to source, "template" to (template ?: Undefined))
}

class Measure(
    val id: String, val type: String, var at: Long, val announcedAt: Long, val params: MutableMap<String, Any?>,
    var withdrawAt: Long? = null, var withdrawnAnnouncedAt: Long? = null,
)

/** A suggested decision, postable as is to POST /api/disruptions/{id}/measures (type, label, why, probability?, plus params). */
class Proposal(var measures: List<Map<String, Any?>>, var note: String) : JsonLike {
    override fun toJson() = obj("measures" to measures, "note" to note)
}

class Scenario(
    val cause: Pair<String, String>, // code, label
    val initial: String, // interrupted | limited
    val start: Long,
    var durationType: String,
    var until: Long?,
    val measures: MutableList<Measure> = ArrayList(),
    var lines: List<String> = emptyList(),
    val a: String,
    val b: String? = null,
    val inside: List<String> = emptyList(),
    val busStops: List<String> = emptyList(),
    val committed: MutableMap<String, Int> = LinkedHashMap(),
    var committedStart: MutableMap<String, Int>? = null,
    val bulletins: MutableList<Bulletin> = ArrayList(),
    var proposal: Proposal = Proposal(emptyList(), ""),
    val linkedTrain: String? = null,
    var warnings: List<String>? = null,
    var resumedAt: Long? = null,
) {
    val causeJson get() = obj("code" to cause.first, "label" to cause.second)
}

/** The effective timetable's changes to one trip (src/disruptions.ts TripChange). */
class TripChange(
    val by: String, // disruption id
    var cut: Int? = null, // last served call; 0 = the whole trip is cancelled
    var startAt: Int? = null, // first served call
    var holdAt: Int? = null,
    var holdUntil: Double? = null,
    val reason: String, // short_turn | cancel_lines | one_track_open | hold
    var committed: Boolean = false,
)
val tripChanges = LinkedHashMap<String, TripChange>()
/** Bumped whenever the effective timetable is rebuilt. */
object Effective { @Volatile var generation = 0 }

class Disruption(
    val id: String, val type: String, var label: String, val reasonCode: String, var effect: String, val scope: Scope, val where: String,
    val params: MutableMap<String, Any?>, val startedAt: Long, var endsAt: Long?, var endedAt: Long? = null, val note: String?,
    val edges: MutableSet<Int>, val station: Int?, val geometry: Map<String, Any?>?, val affected: MutableSet<String> = LinkedHashSet(),
    var scenario: Scenario? = null,
)
val Disruption.isScenario get() = scenario != null

class Incident(
    val id: String, var title: String, var description: String, var severity: String, val type: String?, val reasonCode: String?,
    val scope: Scope, var where: String, val geometry: Map<String, Any?>?, val disruptionId: String? = null,
    val source: String? = null, // staff | auto | control
    var trainIds: List<String>? = null, val createdAt: Long, var updatedAt: Long,
    // control incidents (scenario disruptions): the latest bulletin's facts
    val cause: Pair<String, String>? = null, val effect: String? = null, val lines: List<String>? = null, val durationType: String? = null,
    val until: Long? = null, val lifecycle: String? = null, val bulletinVersion: Int? = null, val messages: List<BulletinMessage>? = null, val replacementBus: Boolean? = null,
) {
    /** The incident as published (incidents/{id}, GET /api/incidents): `{v: 1, ...incident, status}`. */
    fun payload(statusOverride: String? = null): Map<String, Any?> {
        val m = obj(
            "v" to 1, "id" to id, "title" to title, "description" to description, "severity" to severity,
            "type" to (type ?: Undefined), "reasonCode" to (reasonCode ?: Undefined), "scope" to scope, "where" to where, "geometry" to geometry,
            "disruptionId" to (disruptionId ?: Undefined), "source" to (source ?: Undefined), "trainIds" to (trainIds ?: Undefined),
            "createdAt" to createdAt, "updatedAt" to updatedAt,
        )
        if (source == "control") {
            m["cause"] = obj("code" to cause!!.first, "label" to cause.second)
            m["effect"] = effect; m["lines"] = lines; m["durationType"] = durationType; m["until"] = until
            m["lifecycle"] = lifecycle; m["bulletinVersion"] = bulletinVersion; m["messages"] = messages; m["replacementBus"] = replacementBus
        }
        m["status"] = statusOverride ?: if (lifecycle == "ENDED") "ended" else "active"
        return m
    }
}

val disruptions = LinkedHashMap<String, Disruption>()
val incidents = LinkedHashMap<String, Incident>()

class InputError(message: String) : RuntimeException(message)

fun newId(prefix: String, n: Int) = prefix + UUID.randomUUID().toString().replace("-", "").take(n)

fun describeScope(scope: Scope): String = when (scope.kind) {
    "section" -> "${stopName(scope.from!!)} – ${stopName(scope.to!!)}"
    "station" -> stopName(scope.station!!)
    "area" -> "${Json.num(scope.radiusKm!!)} km around ${"%.3f".format(java.util.Locale.ROOT, scope.lat!!)}, ${"%.3f".format(java.util.Locale.ROOT, scope.lon!!)}"
    "line" -> "Line ${scope.line}"
    "network" -> "Network"
    else -> scope.trainId ?: ""
}

/** A disruption created by the twin itself (rear-end collisions), not from the API. */
fun addSystemDisruption(type: String, label: String, reasonCode: String, effect: String, scope: Scope, where: String, params: Map<String, Any?> = emptyMap(), origin: String): Disruption {
    val d = Disruption(
        id = newId("d-", 8), type = type, label = label, reasonCode = reasonCode, effect = effect, scope = scope, where = where,
        params = LinkedHashMap(params), startedAt = Clock.now(), endsAt = null, note = origin, edges = HashSet(), station = null, geometry = null,
    )
    disruptions[d.id] = d
    return d
}

/** What a train looks like to createDisruption (the API's train lookup). */
class TrainRef(val label: String, val nextStation: Int?, val obstacleAt: ((Double) -> Pair<Int, Double>?)? = null)

fun createDisruption(input: Map<String, Any?>, train: ((String) -> TrainRef?)? = null): Disruption {
    val typeName = input["type"]?.toString() ?: ""
    val type = TYPES.find { it.id == (ALIASES[typeName] ?: typeName) } ?: throw InputError("Unknown disruption type \"$typeName\"")
    val scope = Scope.fromMap(input["scope"].asMap())
    if (scope == null || scope.kind != type.scope) throw InputError("\"${type.id}\" needs a ${type.scope} scope")
    var edges: MutableSet<Int> = HashSet()
    var station: Int? = null
    val extra = LinkedHashMap<String, Any?>()
    if (scope.kind == "section") {
        val a = stationIndex(scope.from ?: ""); val b = stationIndex(scope.to ?: "")
        if (a == null || b == null || a == b) throw InputError("A section needs two different known stations")
        edges = sectionEdges(stops[a], stops[b])
        if (edges.isEmpty()) throw InputError("No track found between these stations")
    } else if (scope.kind == "station") {
        station = stationIndex(scope.station ?: "") ?: throw InputError("Unknown station")
    } else {
        val t = train?.invoke(scope.trainId ?: "") ?: throw InputError("That train is not in service now")
        if (type.effect == "skip_stop") station = t.nextStation
        if (type.effect == "obstacle") {
            val at = t.obstacleAt?.invoke(Math.max(30.0, jsNumber(input["params"].asMap()?.get("distanceM") ?: 400)))
                ?: throw InputError("No track ahead of this train")
            extra["atLeg"] = at.first; extra["atS"] = at.second
        }
    }
    val minutes: Any? = if (input.containsKey("minutes")) input["minutes"] else type.defaultMinutes
    val now = Clock.now()
    val params = LinkedHashMap<String, Any?>()
    type.params?.let { params.putAll(it) }
    input["params"].asMap()?.let { params.putAll(it) }
    params.putAll(extra)
    val mins = jsNumber(minutes)
    val d = Disruption(
        id = newId("d-", 8), type = type.id, label = type.label, reasonCode = type.reasonCode, effect = type.effect, scope = scope,
        where = if (scope.kind == "train") "${train?.invoke(scope.trainId!!)?.label ?: scope.trainId}${if (type.effect == "skip_stop" && station != null) " (skips ${stops[station].name})" else ""}" else describeScope(scope),
        params = params, startedAt = now, endsAt = if (minutes != null && mins != 0.0 && !mins.isNaN()) now + (mins * 60_000).toLong() else null,
        note = input["note"] as? String, edges = edges, station = station,
        geometry = if (scope.kind == "section") edgesGeometry(edges) else if (scope.kind == "station" && station != null) obj("type" to "Point", "coordinates" to listOf(stops[station].lon, stops[station].lat)) else null,
    )
    disruptions[d.id] = d
    return d
}

private fun scopeGeometry(scope: Scope): Map<String, Any?>? {
    if (scope.kind == "station") {
        val s = stationIndex(scope.station ?: "")?.let { stops[it] } ?: return null
        return obj("type" to "Point", "coordinates" to listOf(s.lon, s.lat))
    }
    if (scope.kind == "section") {
        val a = stationIndex(scope.from ?: ""); val b = stationIndex(scope.to ?: "")
        return if (a != null && b != null) edgesGeometry(sectionEdges(stops[a], stops[b])) else null
    }
    return null
}

/** Mark an incident from an API body (title required). */
fun createIncident(input: Map<String, Any?>): Incident {
    val now = Clock.now()
    val scope = Scope.fromMap(input["scope"].asMap()) ?: Scope("network")
    val where = (input["where"] as? String) ?: describeScope(scope)
    val inc = Incident(
        id = (input["id"] as? String) ?: newId("i-", 8), title = input["title"].toString(), description = (input["description"] as? String) ?: "",
        severity = (input["severity"] as? String) ?: "major", type = input["type"] as? String, reasonCode = input["reasonCode"] as? String, scope = scope, where = where,
        geometry = (input["geometry"] as? Map<String, Any?>) ?: scopeGeometry(scope), disruptionId = input["disruptionId"] as? String,
        createdAt = input["createdAt"].asLong() ?: now, updatedAt = now,
    )
    incidents[inc.id] = inc
    return inc
}
