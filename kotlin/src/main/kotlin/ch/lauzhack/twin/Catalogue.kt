package ch.lauzhack.twin

/** What a disruption can be (its cause) and what the control centre can decide on it (src/catalogue.ts). */
class Cause(val code: String, val label: String, val effect: String, val minutes: Int, val durationType: String, val busShare: Double, val clauseEn: String) : JsonLike {
    override fun toJson() = obj("code" to code, "label" to label, "effect" to effect, "minutes" to minutes, "durationType" to durationType, "busShare" to busShare, "clause" to obj("en" to clauseEn), "defaultMinutes" to minutes)
}
private fun c(code: String, label: String, effect: String, minutes: Int, dt: String, bus: Double, en: String) = Cause(code, label, effect, minutes, dt, bus, en)

val CAUSES = listOf(
    c("EG_010", "Technical fault on the infrastructure", "interrupted", 120, "UNTIL_AT_LEAST", 0.64, "technical difficulties on the infrastructure"),
    c("EG_047", "Person accident", "interrupted", 180, "UNTIL_AT_LEAST", 0.77, "an accident involving a person"),
    c("EG_070", "Event outside our control", "interrupted", 180, "UNTIL", 0.71, "an event outside of our control"),
    c("EG_006", "Track damage", "interrupted", 225, "UNTIL_AT_LEAST", 0.66, "damage to the tracks"),
    c("EG_008", "Overhead line fault", "interrupted", 240, "UNTIL_AT_LEAST", 0.58, "a defect in the overhead line"),
    c("EG_014", "Train blocking the line", "interrupted", 90, "UNTIL", 0.36, "a train blocking the tracks"),
    c("EG_158", "Extraordinary construction work", "interrupted", 240, "UNTIL", 0.73, "exceptional construction work"),
    c("EG_001", "Level crossing fault", "interrupted", 90, "UNTIL", 0.71, "a disrupted level crossing"),
    c("EG_110", "Fire", "interrupted", 105, "UNTIL", 0.83, "a fire"),
    c("EG_063", "Operational disruption", "interrupted", 105, "UNTIL", 0.5, "a service disruption"),
    c("EG_193", "Collision with a vehicle", "interrupted", 195, "UNTIL", 0.8, "a collision with a vehicle"),
    c("EG_100", "Obstacle on the track", "interrupted", 180, "UNTIL", 0.89, "an obstacle on the tracks"),
    c("EG_028", "Derailment", "interrupted", 240, "UNTIL_AT_LEAST", 1.0, "a derailment"),
    c("EG_052", "Vandalism", "limited", 120, "UNTIL", 1.0, "vandalism"),
    c("EG_011", "Power cut", "interrupted", 210, "UNTIL_AT_LEAST", 0.5, "a power failure"),
    c("EG_030", "Road vehicle incident", "interrupted", 165, "UNTIL", 0.75, "an incident with a road vehicle"),
    c("EG_046", "People near the track", "interrupted", 105, "UNTIL", 0.33, "people close to the track"),
    c("EG_050", "Animals near the track", "limited", 30, "UNTIL", 0.0, "animals close to the track"),
    c("EG_049", "Police operation", "interrupted", 60, "UNTIL", 0.0, "a police operation"),
)
fun causeOf(code: String) = CAUSES.find { it.code == code }

class MeasureDef(val type: String, val label: String, val states: List<String>, val params: Map<String, String>, val behaviour: String) : JsonLike {
    override fun toJson() = obj("type" to type, "label" to label, "states" to states, "params" to params, "behaviour" to behaviour)
}
private val IL = listOf("interrupted", "limited")
val MEASURES = listOf(
    MeasureDef("hold", "Hold trains", listOf("interrupted"), mapOf("maxWaitMin" to "longest wait before a train is turned back instead (default 20)"), "Trains wait at the last station before the section and continue when it reopens. Without short turns this is what every train does."),
    MeasureDef("short_turn", "Short turn", IL, mapOf("at" to "\"A\", \"B\" or \"both\" (default both): which side turns trains back"), "A train that would wait more than 20 minutes ends its run at the last open station before the section; its remaining stops are cancelled and the vehicle leaves service. Trains that already passed continue."),
    MeasureDef("replacement_bus", "Replacement bus", IL, linkedMapOf("firstInMin" to "first departure, minutes after the decision (default 15)", "everyMin" to "interval per direction (default 15)", "minutesA" to "or fixed minutes past the hour from A, e.g. [10, 40]", "minutesB" to "and from B", "withdrawAt" to "epoch ms: last departures before this time"), "Buses (EV) run in both directions between A and B, calling at the stations between. They are real trips: fleet, boards and the journey planner show them, and rail closures do not stop them."),
    MeasureDef("cancel_lines", "Cancel lines", IL, mapOf("lines" to "line names, e.g. [\"S2\", \"S25\"]"), "From its time, trains of these lines do not run through the section: they end at the last station before it."),
    MeasureDef("one_track_open", "One track open", listOf("limited"), linkedMapOf("kmh" to "speed through the section (default 40)", "cancelShare" to "share of trains cancelled through the section, 0..1 (default 0.5)"), "Trains run through on one track at reduced speed; the chosen share (picked by train) ends at the last station before the section."),
    MeasureDef("partial_resumption", "Partial resumption", listOf("interrupted"), emptyMap(), "The disruption becomes limited at its time (interrupted -> limited)."),
    MeasureDef("interruption", "Interruption", listOf("limited"), emptyMap(), "The disruption becomes interrupted again (limited -> interrupted)."),
    MeasureDef("prognosis", "Recovery prognosis", IL, linkedMapOf("until" to "epoch ms or HH:MM", "minutes" to "or minutes from now", "durationType" to "UNTIL | UNTIL_AT_LEAST | UNKNOWN"), "A new expected end. Holds, short turns and buses follow it."),
    MeasureDef("resume", "Resume", IL, emptyMap(), "Service resumed at its time: trains run again, held trains continue, future buses are withdrawn."),
)
private fun label(type: String) = MEASURES.find { it.type == type }?.label ?: type

/** The default plan for a new disruption, suggested to the operator (applied only on request). */
fun proposal(cause: Cause, effect: String, remainingMin: Double?): Proposal {
    val out = ArrayList<Map<String, Any?>>()
    if (effect == "interrupted") {
        if (remainingMin != null && remainingMin <= 20) out.add(obj("type" to "hold", "label" to label("hold"), "why" to "The line should reopen within ${jsRoundL(remainingMin)} minutes: trains wait."))
        else out.add(obj("type" to "short_turn", "label" to "Short-turn trains at both ends", "at" to "both", "why" to if (remainingMin == null) "No reopening time is known: trains end their run before the section." else "The interruption lasts about ${jsRoundL(remainingMin)} more minutes: trains end their run before the section instead of waiting."))
    } else out.add(obj("type" to "one_track_open", "label" to "One track open, every second train cancelled", "kmh" to 40, "cancelShare" to 0.5, "why" to "One track open: trains run slowly through it and every second one ends before the section."))
    if (cause.busShare >= 0.5) out.add(obj("type" to "replacement_bus", "label" to "Replacement buses every 15 min", "firstInMin" to 15, "everyMin" to 15, "probability" to cause.busShare, "why" to "${jsRoundL(cause.busShare * 100)} % of real ${cause.label.lowercase()} incidents had a replacement bus."))
    val note = "Based on real ${cause.label.lowercase()} incidents${if (remainingMin == null) "" else " and about ${jsRoundL(remainingMin)} minutes to go"}."
    return Proposal(out, note)
}
