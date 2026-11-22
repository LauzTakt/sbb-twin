package ch.lauzhack.twin

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** The twin's clock. With RAIL_REPLAY="2026-09-10T05:30" (Swiss local time) it runs on a virtual clock starting there at
 *  RAIL_REPLAY_SPEED times real speed (default 1). Everything reads time through Clock.now(). */
object Clock {
    private val spec = System.getenv("RAIL_REPLAY") ?: ""
    val replaySpeed: Double = maxOf(1.0, (System.getenv("RAIL_REPLAY_SPEED") ?: "1").toDoubleOrNull() ?: 1.0)
    val replayFrom: Long? = Regex("^(\\d{4}-\\d{2}-\\d{2})T(\\d{1,2}):(\\d{2})$").find(spec)?.let {
        serviceOrigin(it.groupValues[1]) + (it.groupValues[2].toLong() * 60 + it.groupValues[3].toLong()) * 60_000
    }
    private val realStart = System.currentTimeMillis()
    val replaying get() = replayFrom != null

    init {
        if (spec.isNotEmpty() && replayFrom == null) throw IllegalArgumentException("RAIL_REPLAY must look like 2026-09-10T05:30, not \"$spec\"")
        if (replayFrom != null) println("[sbb-twin] replay clock from $spec at ${replaySpeed}x")
    }

    fun now(): Long = if (replayFrom != null) Math.round(replayFrom + (System.currentTimeMillis() - realStart) * replaySpeed) else System.currentTimeMillis()

    /** Real milliseconds until the next tick: one virtual second. */
    fun nextTickIn(): Long = if (replaying) maxOf(5.0, 1000 / replaySpeed - ((now() % 1000) / replaySpeed)).toLong() else 1000 - (now() % 1000) + 5
}

private val ZURICH = ZoneId.of("Europe/Zurich")

class ZurichTime(val date: String, val time: String)

/** Swiss local date (YYYY-MM-DD) and time (HH:MM:SS) of an instant. */
fun zurich(ms: Long): ZurichTime {
    val z = Instant.ofEpochMilli(ms).atZone(ZURICH)
    return ZurichTime(z.toLocalDate().toString(), "%02d:%02d:%02d".format(z.hour, z.minute, z.second))
}
fun zurich(ms: Double) = zurich(ms.toLong())

fun offsetMinutes(ms: Long): Int = ZURICH.rules.getOffset(Instant.ofEpochMilli(ms)).totalSeconds / 60

/** Epoch ms of the GTFS time origin of a service date (YYYY-MM-DD): noon minus 12 h in Swiss time. */
fun serviceOrigin(date: String): Long {
    val noon = Instant.parse("${date}T12:00:00Z").toEpochMilli()
    return noon - offsetMinutes(noon) * 60_000L - 12 * 3_600_000L
}
fun addDays(date: String, n: Int): String = LocalDate.parse(date).plusDays(n.toLong()).toString()
fun compactDate(date: String) = date.replace("-", "")

/** JS Math.round: halves round up (towards +infinity). */
fun jsRound(x: Double): Double = Math.floor(x + 0.5)
fun jsRoundL(x: Double): Long = Math.floor(x + 0.5).toLong()

/** The twin's state is single-threaded like the TypeScript original: the tick loop, every API request, the GTFS-RT and
 *  alert pollers and the planner warm-up run inside `locked { }`. */
object World
inline fun <T> locked(block: () -> T): T = synchronized(World) { block() }
