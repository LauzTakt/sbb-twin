package ch.lauzhack.twin

import com.fasterxml.jackson.core.JsonFactory
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.core.JsonToken
import java.io.File
import java.text.Normalizer
import java.util.zip.GZIPInputStream

class Stop(val id: String, val name: String, val lon: Double, val lat: Double)

/** One trip of a service day. Times are epoch ms (planned). */
class Trip(
    val key: String, // day-index instance id: "YYYYMMDD/<trip_id>[/<start>]"
    val trainId: String, // MQTT-safe id: "YYYYMMDD_<trip_id without leading dot>[_<start>]"
    val tripId: String,
    val serviceDate: String, // YYYYMMDD
    val cat: String,
    val line: String,
    val head: String,
    val stops: IntArray, // station indexes
    val arr: DoubleArray,
    val dep: DoubleArray,
)

private class RawDay(val stops: List<Array<Any>>, val trips: List<RawTrip>)
private class RawTrip(val key: String, val cat: String, val line: String, val head: String, val flat: IntArray)

object Timetable {
    var stops: List<Stop> = emptyList()
        private set
    private val byId = HashMap<String, Int>()
    fun stationIndex(id: String): Int? = byId[id]
    fun replaceStops(list: List<Stop>) {
        stops = list
        byId.clear()
        list.forEachIndexed { i, s -> byId[s.id] = i }
    }
}

/** Stations by index (the day index's stop list). */
val stops: List<Stop> get() = Timetable.stops
fun stationIndex(id: String): Int? = Timetable.stationIndex(id)
fun stopName(id: String): String = stationIndex(id)?.let { stops[it].name } ?: id

private val ws = Regex("\\s+")
private val unsafe = Regex("[+#/\\s]")

private fun readDay(file: File): RawDay {
    val stopsOut = ArrayList<Array<Any>>()
    val trips = ArrayList<RawTrip>(60_000)
    GZIPInputStream(file.inputStream().buffered(1 shl 16)).use { gz ->
        JsonFactory().createParser(gz).use { p ->
            p.nextToken()
            while (p.nextToken() == JsonToken.FIELD_NAME) {
                val name = p.currentName(); p.nextToken()
                when (name) {
                    "stops" -> while (p.nextToken() == JsonToken.START_ARRAY) {
                        p.nextToken(); val id = p.text; p.nextToken(); val n = p.text; p.nextToken(); val lon = p.doubleValue; p.nextToken(); val lat = p.doubleValue
                        p.nextToken() // END_ARRAY
                        stopsOut.add(arrayOf(id, n, lon, lat))
                    }
                    "trips" -> while (p.nextToken() == JsonToken.START_ARRAY) {
                        p.nextToken(); val key = p.text; p.nextToken(); val cat = p.text; p.nextToken(); val line = p.text; p.nextToken(); val head = p.text
                        p.nextToken() // START_ARRAY of the flat numbers
                        var buf = IntArray(96); var n = 0
                        while (p.nextToken() != JsonToken.END_ARRAY) { if (n == buf.size) buf = buf.copyOf(n * 2); buf[n++] = p.intValue }
                        p.nextToken() // END_ARRAY of the trip
                        trips.add(RawTrip(key, cat, line, head, buf.copyOf(n)))
                    }
                    else -> p.skipChildren()
                }
            }
        }
    }
    return RawDay(stopsOut, trips)
}

private fun dayFile(date: String) = File(Config.daysDir, "day-$date.json.gz")

private fun buildTrip(raw: RawTrip, origin: Long, map: IntArray?): Trip? {
    val parts = raw.key.split("/")
    val serviceDate = parts[0]; val tripId = parts[1]; val start = parts.getOrNull(2)
    val n = raw.flat.size / 3
    val s = IntArray(n); val arr = DoubleArray(n); val dep = DoubleArray(n)
    for (i in 0 until n) {
        val idx = raw.flat[i * 3]
        s[i] = if (map == null) idx else map.getOrElse(idx) { -1 }
        if (s[i] < 0) return null
        arr[i] = (origin + raw.flat[i * 3 + 1] * 1000L).toDouble()
        dep[i] = (origin + raw.flat[i * 3 + 2] * 1000L).toDouble()
    }
    val trainId = "${serviceDate}_${tripId.removePrefix(".")}${if (!start.isNullOrEmpty()) "_$start" else ""}".replace(unsafe, "-")
    return Trip(raw.key, trainId, tripId, serviceDate, raw.cat, raw.line.replace(ws, ""), raw.head, s, arr, dep)
}

/** Load a service day (replaces the stop list on first load). */
fun loadDay(date: String): List<Trip> {
    val file = dayFile(date)
    if (!file.exists()) throw IllegalStateException("No timetable for $date in ${Config.daysDir}")
    val day = readDay(file)
    if (Timetable.stops.isEmpty() || day.stops.size != Timetable.stops.size) Timetable.replaceStops(day.stops.map { Stop(it[0] as String, it[1] as String, it[2] as Double, it[3] as Double) })
    val origin = serviceOrigin(date)
    return day.trips.mapNotNull { buildTrip(it, origin, null) }
}

/** Another service day's trips on the current stop list (stops it does not know drop the trip); [] when no file. */
fun loadDayMapped(date: String): List<Trip> {
    val file = dayFile(date)
    if (!file.exists()) return emptyList()
    val day = readDay(file)
    val map = IntArray(day.stops.size) { stationIndex(day.stops[it][0] as String) ?: -1 }
    val origin = serviceOrigin(date)
    return day.trips.mapNotNull { buildTrip(it, origin, map) }
}

private fun norm(s: String) = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}"), "").lowercase()

fun searchStations(q: String, limit: Int = 8): List<Stop> {
    val n = norm(q.trim())
    if (n.isEmpty()) return emptyList()
    val hits = stops.filter { norm(it.name).contains(n) || it.id == q.trim() }
    fun rank(s: Stop) = if (norm(s.name) == n) 0 else if (norm(s.name).startsWith(n)) 1 else 2
    return hits.sortedWith(compareBy<Stop>({ rank(it) }, { it.name.length })).take(limit)
}
