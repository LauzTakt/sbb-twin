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
