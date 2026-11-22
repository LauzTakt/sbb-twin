package ch.lauzhack.twin

/** Live delays, skipped stops and cancellations from the GTFS-RT TripUpdates feed (src/realtime.ts). */
class StopUpdate(val stopId: String?, val seq: Int?, val arrDelay: Double?, val depDelay: Double?, val arrTime: Double?, val depTime: Double?, val skipped: Boolean)
class TripLive(val cancelled: Boolean, val updates: List<StopUpdate>)

object Live {
    @Volatile var trips: Map<String, TripLive> = HashMap() // key "YYYYMMDD/<trip_id>" (same as the day index)
    @Volatile var fetchedAt: Long = 0
    @Volatile var feedTime: Long = 0
    @Volatile var error: String? = null
    fun enabled() = Config.gtfsRtKey.isNotEmpty()
}

/** Swiss Location IDs ("ch:1:sloid:10665:0:19728" = station 8510665) or numeric station ids ("8503000:0:5", "Parent8503000"). */
fun rtStation(stopId: String): String {
    Regex("^ch:1:sloid:(\\d+)").find(stopId)?.let { return "85" + it.groupValues[1].padStart(5, '0') }
    return stopId.removePrefix("Parent").split(":")[0]
}

// ---------------------------------------------------------------- polling the GTFS-RT TripUpdates feed
private val httpRt = java.net.http.HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(20)).build()

/** Download a protobuf feed (gzip handled by header or magic bytes). */
fun fetchFeed(url: String, key: String, userAgent: String, timeoutSec: Long = 20): ByteArray {
    val req = java.net.http.HttpRequest.newBuilder(java.net.URI.create(url)).timeout(java.time.Duration.ofSeconds(timeoutSec))
        .header("Authorization", "Bearer $key").header("User-Agent", userAgent).header("Accept-Encoding", "gzip, deflate").GET().build()
    val r = httpRt.send(req, java.net.http.HttpResponse.BodyHandlers.ofByteArray())
    if (r.statusCode() !in 200..299) throw IllegalStateException("HTTP ${r.statusCode()}")
    var b = r.body()
    if (b.size > 2 && (b[0].toInt() and 0xff) == 0x1f && (b[1].toInt() and 0xff) == 0x8b) b = java.util.zip.GZIPInputStream(b.inputStream()).use { it.readBytes() }
    return b
}

/** Decode a TripUpdates FeedMessage. Mirrors protobufjs static-code defaults: a present arrival/departure without
 *  delay (or time) reads as 0, which the TS twin treats as a real value. Returns trips and the header timestamp (ms). */
fun decodeTripUpdates(buf: ByteArray): Pair<Map<String, TripLive>, Long> {
    val feed = Proto.parse(buf)
    val ts = feed.first(1)?.message()?.first(3)?.varint ?: 0L
    val trips = HashMap<String, TripLive>()
    for (e in feed.all(2)) {
        val tu = e.message().first(3)?.message() ?: continue
        val trip = tu.first(1)?.message() ?: emptyList()
        val id = trip.first(1)?.string() ?: ""
        if (id.isEmpty()) continue
        val startDate = trip.first(3)?.string() ?: ""
        val cancelled = (trip.first(4)?.varint ?: 0L) == 3L
        val updates = tu.all(2).map { u ->
            val f = u.message()
            // StopTimeEvent: delay = 1 (int32), time = 2 (int64)
            fun event(n: Int): Pair<Double?, Double?> {
                val x = f.first(n)?.message() ?: return null to null
                return (x.first(1)?.varint?.toInt() ?: 0).toDouble() to (x.first(2)?.varint ?: 0L).toDouble()
            }
            val (ad, at) = event(2); val (dd, dt) = event(3)
            val stop = f.first(4)?.string() ?: ""
            StopUpdate(
                stopId = if (stop.isNotEmpty()) rtStation(stop) else null, seq = (f.first(1)?.varint ?: 0L).toInt(),
                arrDelay = ad, depDelay = dd, arrTime = at, depTime = dt, skipped = (f.first(5)?.varint ?: 0L) == 1L,
            )
        }
        trips["$startDate/$id"] = TripLive(cancelled, updates)
    }
    return trips to ts * 1000
}

/** Poll the feed (blocking network I/O outside the world lock); true when fresh data was stored. */
fun pollRealtime(): Boolean {
    if (Config.gtfsRtKey.isEmpty()) return false
    return try {
        val (trips, ts) = decodeTripUpdates(fetchFeed(Config.gtfsRtUrl, Config.gtfsRtKey, "sbb-twin (LauzHack 2026)"))
        locked { Live.trips = trips; Live.fetchedAt = Clock.now(); Live.feedTime = ts; Live.error = null }
        true
    } catch (e: Exception) {
        Live.error = if (e.message?.startsWith("HTTP") == true) "GTFS-RT ${e.message}" else (e.message ?: e.toString())
        false
    }
}
