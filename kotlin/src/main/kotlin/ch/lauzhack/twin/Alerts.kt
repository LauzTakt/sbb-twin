package ch.lauzhack.twin

/** Real service alerts from opentransportdata.swiss GTFS-RT Service Alerts (src/alerts.ts). */
class AlertStation(val id: String, val name: String) : JsonLike { override fun toJson() = obj("id" to id, "name" to name) }

class RealAlert(
    val id: String, val source: String, val title: String, var description: String, val language: String, val cause: String, val severity: String,
    val url: String?, val activePeriods: List<Map<String, Any?>>, val stations: MutableList<AlertStation>, val trainIds: MutableList<String>,
    var geometry: Any?, val sourceIds: MutableList<String>, val updatedAt: Long,
) {
    fun toMap(): Map<String, Any?> = obj(
        "v" to 1, "id" to id, "source" to source, "title" to title, "description" to description, "language" to language, "cause" to cause, "severity" to severity,
        "url" to url, "activePeriods" to activePeriods, "stations" to stations, "trainIds" to trainIds, "geometry" to geometry, "sourceIds" to sourceIds, "updatedAt" to updatedAt,
    )
    /** Without trainIds, sourceIds and geometry, plus the number of trains. */
    fun briefMap(): Map<String, Any?> = LinkedHashMap(toMap()).also { it.remove("trainIds"); it.remove("sourceIds"); it.remove("geometry"); it["trains"] = trainIds.size }
    /** For the control page: without trainIds and sourceIds (geometry kept), plus the number of trains. */
    fun channelMap(): Map<String, Any?> = LinkedHashMap(toMap()).also { it.remove("trainIds"); it.remove("sourceIds"); it["trains"] = trainIds.size }
}

object AlertsState {
    @Volatile var alerts: Map<String, RealAlert> = LinkedHashMap()
    @Volatile var fetchedAt = 0L
    @Volatile var feedAt = 0L
    @Volatile var error: String? = null
}

private val ALERT_CAUSES = listOf("unknown", "unknown", "other", "technical problem", "strike", "demonstration", "accident", "holiday", "other", "maintenance", "construction", "police activity", "medical emergency")
private const val SOURCE = "opentransportdata.swiss GTFS-RT service alerts"

class Translated(val text: String, val language: String)
class Informed(val stopId: String?, val tripId: String?, val startDate: String?)
class RawAlert(val periods: List<Pair<Long?, Long?>>, val informed: List<Informed>, val cause: Int?, val url: List<Translated>, val header: List<Translated>, val description: List<Translated>)
class RawEntity(val id: String, val isDeleted: Boolean, val alert: RawAlert?)
class RawFeed(val timestamp: Long, val entities: List<RawEntity>)

private fun translated(f: ProtoField?): List<Translated> = f?.message()?.all(1)?.map { t -> val m = t.message(); Translated(m.first(1)?.string() ?: "", m.first(2)?.string() ?: "") } ?: emptyList()

/** Decode the Service Alerts FeedMessage (only the fields an alert needs; unknown fields are skipped). */
fun decodeAlerts(buf: ByteArray): RawFeed {
    val feed = Proto.parse(buf)
    val ts = feed.first(1)?.message()?.first(3)?.varint ?: 0L
    val ents = feed.all(2).map { e ->
        val m = e.message()
        val a = m.first(5)?.message()
        RawEntity(m.first(1)?.string() ?: "", (m.first(2)?.varint ?: 0L) != 0L, a?.let { al ->
            RawAlert(
                al.all(1).map { p -> val x = p.message(); x.first(1)?.varint to x.first(2)?.varint },
                al.all(5).map { ie -> val x = ie.message(); val trip = x.first(4)?.message(); Informed(x.first(5)?.string(), trip?.first(1)?.string(), trip?.first(3)?.string()) },
                al.first(6)?.varint?.toInt(), translated(al.first(8)), translated(al.first(10)), translated(al.first(11)),
            )
        })
    }
    return RawFeed(ts, ents)
}

fun alertText(all: List<Translated>): Pair<String, String> {
    val pick = all.find { it.language == "en" } ?: all.find { it.language == "de" } ?: all.firstOrNull()
    return (pick?.text ?: "").trim() to (pick?.language ?: "")
}

private val INFO_RE = Regex("wheelchair|lift|elevator|escalator|toilet|ticket machine|step-free|accessib", RegexOption.IGNORE_CASE)
private val MAJOR_RE = Regex("interrupt|no (train )?service|not running|cancel|suspended|blocked|closed between", RegexOption.IGNORE_CASE)
private val MINOR_RE = Regex("limited|irregular|delay|divert|diversion|replacement|reduced|restriction|disrupt|works", RegexOption.IGNORE_CASE)
fun alertSeverity(s: String) = if (INFO_RE.containsMatchIn(s)) "info" else if (MAJOR_RE.containsMatchIn(s)) "major" else if (MINOR_RE.containsMatchIn(s)) "minor" else "info"

/** Merge key of an alert's title: one event, many alerts. */
fun alertId(title: String): String {
    val key = title.lowercase().replace(Regex("[:\\-–]"), " ").replace(Regex("\\s+"), " ").trim()
    return "sa-" + sha1Hex(key).take(12)
}

fun pollAlerts() {
    if (Config.gtfsSaKey.isEmpty()) return
    try {
        val feed = decodeAlerts(fetchFeed(Config.gtfsSaUrl, Config.gtfsSaKey, "sbb-twin"))
        locked {
            applyAlerts(buildAlerts(feed))
            AlertsState.fetchedAt = Clock.now(); AlertsState.feedAt = feed.timestamp * 1000; AlertsState.error = null
        }
    } catch (e: Exception) {
        AlertsState.error = e.message ?: e.toString()
        System.err.println("[alerts] service alerts unavailable: ${AlertsState.error}")
    }
}

private val MODE_RE = Regex("\\[([^\\]]+)\\]\\s*\\.?\\s*$")
private val TAIL_RE = Regex("\\s*\\[[^\\]]+\\]\\s*\\.?\\s*$")
private val TITLE_TAIL_RE = Regex("\\s*\\[(train|rack railway)\\]\\s*\\.?\\s*$", RegexOption.IGNORE_CASE)
private val SECTION_RES = listOf(
    Regex("between (.+?) and (.+?)(?:,|$)", RegexOption.IGNORE_CASE),
    Regex(":\\s*(.+?)\\s+[-–]\\s+(.+?)\\s*$"),
    Regex("(?:service|works|closure|interruption)\\s+(.+?)\\s+[-–]\\s+(.+?)\\s*$", RegexOption.IGNORE_CASE),
)
private val SUFFIX_RE = Regex("\\s*\\([A-Z]{1,2}\\)\\s*$")
private val COUNTRY_RE = Regex("\\s*\\((?:F|D|I|A|FL)\\)\\s*$", RegexOption.IGNORE_CASE)

fun buildAlerts(feed: RawFeed): LinkedHashMap<String, RealAlert> {
    val now = Clock.now()
    val served = LinkedHashMap<String, Served>(); for (s in servedStations()) served[s.stop.id] = s
    val byName = HashMap<String, Served>(); for (s in served.values) byName[s.stop.name.lowercase()] = s
    val byBase = HashMap<String, Served>(); for (s in served.values) byBase[s.stop.name.replace(SUFFIX_RE, "").lowercase()] = s
    fun unserved(n: String): Served? {
        val hit = stops.find { it.name.lowercase() == n.trim().lowercase() } ?: return null
        val s = Served(hit, 0)
        served[hit.id] = s; byName[hit.name.lowercase()] = s
        return s
    }
    fun named(n: String): Served? = byName[n.trim().lowercase()] ?: byName[n.replace(COUNTRY_RE, "").trim().lowercase()] ?: byBase[n.trim().lowercase()] ?: unserved(n)
    val today = dayTrips().mapTo(HashSet()) { it.trainId }
    val out = LinkedHashMap<String, RealAlert>()
    for (e in feed.entities) {
        val a = e.alert
        if (a == null || e.isDeleted) continue
        val periods = a.periods.map { p -> obj("start" to (p.first?.takeIf { it != 0L }?.let { it * 1000 }), "end" to (p.second?.takeIf { it != 0L }?.let { it * 1000 })) }
        if (periods.isNotEmpty() && a.periods.none { p -> ((p.first?.takeIf { it != 0L }?.let { it * 1000 }) ?: 0L) <= now && ((p.second?.takeIf { it != 0L }?.let { it * 1000 }) ?: Long.MAX_VALUE) >= now }) continue
        val (headText, headLang) = alertText(a.header)
        val (bodyText, _) = alertText(a.description)
        val mode = MODE_RE.find(headText)?.groupValues?.get(1)?.lowercase()
        val railMode = mode == "train" || mode == "rack railway"
        if (mode != null && !railMode) continue
        val stationIds = LinkedHashSet<String>(); val trainIds = LinkedHashSet<String>()
        for (ie in a.informed) {
            if (!ie.stopId.isNullOrEmpty()) { val id = rtStation(ie.stopId); if (served.containsKey(id)) stationIds.add(id) }
            if (!ie.tripId.isNullOrEmpty() && !ie.startDate.isNullOrEmpty()) { val id = "${ie.startDate}_${ie.tripId.removePrefix(".")}"; if (id in today) trainIds.add(id) }
        }
        if (stationIds.isEmpty() && trainIds.isEmpty() && !railMode) continue
        var geometry: Any? = null
        val plain = headText.replace(TAIL_RE, "").replace(Regex("\\.\\s*$"), "")
        var from: Served? = null; var to: Served? = null
        for (re in SECTION_RES) {
            val m = re.find(plain) ?: continue
            val x = named(m.groupValues[1]); val y = if (x != null) named(m.groupValues[2]) else null
            if (x != null && y != null) { from = x; to = y; break }
        }
        if (from != null && to != null) {
            val ia = stationIndex(from.stop.id); val ib = stationIndex(to.stop.id)
            if (ia != null && ib != null) {
                val edges = sectionEdges(stops[ia], stops[ib])
                val route = if (edges.isEmpty()) abroadRoute(from.stop, to.stop) else null
                geometry = if (edges.isNotEmpty()) edgesGeometry(edges)
                else obj("type" to "MultiLineString", "coordinates" to listOf(if (route != null) listOf(listOf(from.stop.lon, from.stop.lat)) + route + listOf(listOf(to.stop.lon, to.stop.lat)) else listOf(listOf(from.stop.lon, from.stop.lat), listOf(to.stop.lon, to.stop.lat))))
                stationIds.add(from.stop.id); stationIds.add(to.stop.id)
            }
        }
        if (geometry == null && stationIds.isNotEmpty()) geometry = obj("type" to "MultiPoint", "coordinates" to stationIds.map { listOf(served[it]!!.stop.lon, served[it]!!.stop.lat) })
        val title = headText.replace(TITLE_TAIL_RE, "").trim().ifEmpty { "Service information" }
        val id = alertId(title)
        val same = out[id]
        if (same != null) {
            for (s in stationIds) if (same.stations.none { it.id == s }) same.stations.add(AlertStation(s, served[s]!!.stop.name))
            for (t in trainIds) if (t !in same.trainIds) same.trainIds.add(t)
            val gType = (geometry as? Map<*, *>)?.get("type")
            if (gType == "MultiLineString" || (same.geometry == null && geometry != null)) same.geometry = geometry
            else if ((same.geometry as? Map<*, *>)?.get("type") == "MultiPoint") same.geometry = obj("type" to "MultiPoint", "coordinates" to same.stations.map { listOf(served[it.id]!!.stop.lon, served[it.id]!!.stop.lat) })
            if (same.description.isEmpty() && bodyText.isNotEmpty()) same.description = bodyText
            same.sourceIds.add(e.id)
            continue
        }
        out[id] = RealAlert(
            id, SOURCE, title, bodyText, headLang, ALERT_CAUSES.getOrNull(a.cause ?: 1) ?: "unknown", alertSeverity("$headText ${bodyText.take(200)}"),
            alertText(a.url).first.ifEmpty { null }, periods, stationIds.mapTo(ArrayList()) { AlertStation(it, served[it]!!.stop.name) }, ArrayList(trainIds), geometry, arrayListOf(e.id), now,
        )
    }
    return out
}

private fun sig(a: RealAlert): String {
    val m = LinkedHashMap(a.toMap()); m["sourceIds"] = a.sourceIds.sorted(); m["trainIds"] = a.trainIds.sorted(); m["updatedAt"] = 0
    return Json.str(m)
}

fun applyAlerts(next: LinkedHashMap<String, RealAlert>) {
    val before = AlertsState.alerts
    for ((id, a) in next.entries.toList()) {
        val old = before[id]
        if (old != null && sig(old) == sig(a)) next[id] = old else publish("alerts/$id", a.toMap(), retain = true, qos = 1)
    }
    for (id in before.keys) if (!next.containsKey(id)) clear("alerts/$id")
    AlertsState.alerts = next
    sendAlerts()
}

/** What the control page needs (the affected trains as a count). */
fun sendAlerts() {
    Channel.send("alerts", obj("type" to "alerts", "fetchedAt" to AlertsState.fetchedAt, "alerts" to AlertsState.alerts.values.map { it.channelMap() }))
}
