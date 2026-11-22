package ch.lauzhack.twin

import java.io.File

/** Control state survives restarts (src/persist.ts): disruptions (scenarios included) and marked incidents. */
private var lastSaved = ""

private fun measureSaved(m: Measure) = obj("id" to m.id, "type" to m.type, "at" to m.at, "announcedAt" to m.announcedAt, "params" to m.params,
    "withdrawAt" to (m.withdrawAt ?: Undefined), "withdrawnAnnouncedAt" to (m.withdrawnAnnouncedAt ?: Undefined))

private fun scenarioSaved(sc: Scenario) = obj(
    "cause" to sc.causeJson, "initial" to sc.initial, "start" to sc.start, "durationType" to sc.durationType, "until" to sc.until,
    "measures" to sc.measures.map { measureSaved(it) }, "lines" to sc.lines, "a" to sc.a, "b" to (sc.b ?: Undefined), "inside" to sc.inside, "busStops" to sc.busStops,
    "committed" to sc.committed, "committedStart" to (sc.committedStart ?: Undefined), "bulletins" to sc.bulletins, "proposal" to sc.proposal,
    "linkedTrain" to (sc.linkedTrain ?: Undefined), "warnings" to (sc.warnings ?: Undefined), "resumedAt" to (sc.resumedAt ?: Undefined),
)

fun disruptionSaved(d: Disruption) = obj(
    "id" to d.id, "type" to d.type, "label" to d.label, "reasonCode" to d.reasonCode, "effect" to d.effect, "scope" to d.scope, "where" to d.where,
    "params" to d.params, "startedAt" to d.startedAt, "endsAt" to d.endsAt, "endedAt" to (d.endedAt ?: Undefined), "note" to (d.note ?: Undefined),
    "edges" to d.edges.toList(), "station" to (d.station ?: Undefined), "geometry" to d.geometry, "affected" to d.affected.toList(),
    "scenario" to (d.scenario?.let { scenarioSaved(it) } ?: Undefined),
)

fun incidentSaved(i: Incident): Map<String, Any?> = LinkedHashMap(i.payload()).also { it.remove("v"); it.remove("status") }

fun snapshot(): Map<String, Any?> = obj(
    "disruptions" to disruptions.values.map { disruptionSaved(it) },
    "incidents" to incidents.values.filter { it.source != "auto" }.map { incidentSaved(it) }, // automatic ones are recomputed
)

@Suppress("UNCHECKED_CAST")
private fun strings(x: Any?): List<String> = (x as? List<Any?>)?.map { it.toString() } ?: emptyList()

private fun measureFromSaved(m: Map<String, Any?>) = Measure(m["id"] as String, m["type"] as String, m["at"].asLong()!!, m["announcedAt"].asLong()!!,
    LinkedHashMap(m["params"].asMap() ?: emptyMap()), m["withdrawAt"].asLong(), m["withdrawnAnnouncedAt"].asLong())

private fun bulletinFromSaved(m: Map<String, Any?>) = Bulletin(m["id"] as String, m["version"].asLong()!!.toInt(), m["ts"].asLong()!!, (m["lang"] as? String) ?: "en",
    m["lifecycle"] as String, m["title"] as String, m["description"] as String, strings(m["lines"]),
    (m["messages"].asList() ?: emptyList()).map { it.asMap()!! }.map { BulletinMessage(it["ts"].asLong()!!, it["title"] as String, it["text"] as String) },
    (m["source"] as? String) ?: "template", m["template"] as? String)

private fun scenarioFromSaved(m: Map<String, Any?>): Scenario {
    val cause = m["cause"].asMap()!!
    val p = m["proposal"].asMap()
    return Scenario(
        cause = (cause["code"] as String) to (cause["label"] as String), initial = m["initial"] as String, start = m["start"].asLong()!!,
        durationType = m["durationType"] as String, until = m["until"].asLong(),
        measures = (m["measures"].asList() ?: emptyList()).map { measureFromSaved(it.asMap()!!) }.toMutableList(),
        lines = strings(m["lines"]), a = m["a"] as String, b = m["b"] as? String, inside = strings(m["inside"]), busStops = strings(m["busStops"]),
        committed = LinkedHashMap<String, Int>().also { out -> m["committed"].asMap()?.forEach { (k, v) -> out[k] = v.asLong()!!.toInt() } },
        committedStart = m["committedStart"].asMap()?.let { src -> LinkedHashMap<String, Int>().also { out -> src.forEach { (k, v) -> out[k] = v.asLong()!!.toInt() } } },
        bulletins = (m["bulletins"].asList() ?: emptyList()).map { bulletinFromSaved(it.asMap()!!) }.toMutableList(),
        proposal = Proposal((p?.get("measures").asList() ?: emptyList()).mapNotNull { it.asMap() }, (p?.get("note") as? String) ?: ""),
        linkedTrain = m["linkedTrain"] as? String, warnings = m["warnings"]?.let { strings(it) }, resumedAt = m["resumedAt"].asLong(),
    )
}

fun disruptionFromSaved(m: Map<String, Any?>) = Disruption(
    id = m["id"] as String, type = m["type"] as String, label = m["label"] as String, reasonCode = m["reasonCode"] as String, effect = m["effect"] as String,
    scope = Scope.fromMap(m["scope"].asMap())!!, where = m["where"] as String, params = LinkedHashMap(m["params"].asMap() ?: emptyMap()),
    startedAt = m["startedAt"].asLong()!!, endsAt = m["endsAt"].asLong(), endedAt = m["endedAt"].asLong(), note = m["note"] as? String,
    edges = (m["edges"].asList() ?: emptyList()).map { it.asLong()!!.toInt() }.toMutableSet(), station = m["station"].asLong()?.toInt(),
    geometry = m["geometry"].asMap(), affected = LinkedHashSet(strings(m["affected"])), scenario = m["scenario"].asMap()?.let { scenarioFromSaved(it) },
)

fun incidentFromSaved(m: Map<String, Any?>): Incident {
    val c = m["cause"].asMap()
    return Incident(
        id = m["id"] as String, title = m["title"] as String, description = (m["description"] as? String) ?: "", severity = (m["severity"] as? String) ?: "major",
        type = m["type"] as? String, reasonCode = m["reasonCode"] as? String, scope = Scope.fromMap(m["scope"].asMap()) ?: Scope("network"), where = (m["where"] as? String) ?: "",
        geometry = m["geometry"].asMap(), disruptionId = m["disruptionId"] as? String, source = m["source"] as? String, trainIds = m["trainIds"]?.let { strings(it) },
        createdAt = m["createdAt"].asLong() ?: 0, updatedAt = m["updatedAt"].asLong() ?: 0,
        cause = c?.let { (it["code"] as String) to (it["label"] as String) }, effect = m["effect"] as? String, lines = m["lines"]?.let { strings(it) },
        durationType = m["durationType"] as? String, until = m["until"].asLong(), lifecycle = m["lifecycle"] as? String,
        bulletinVersion = m["bulletinVersion"].asLong()?.toInt(),
        messages = m["messages"].asList()?.map { it.asMap()!! }?.map { BulletinMessage(it["ts"].asLong()!!, it["title"] as String, it["text"] as String) },
        replacementBus = m["replacementBus"] as? Boolean,
    )
}

fun saveState() {
    val body = Json.str(snapshot())
    if (body == lastSaved) return
    lastSaved = body
    val f = Config.stateFile
    val tmp = File(f.path + ".tmp")
    tmp.writeText(body)
    java.nio.file.Files.move(tmp.toPath(), f.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
}

/** Restore the saved state; returns (disruptions, incidents) restored so they can be republished. */
fun loadState(): Pair<Int, Int> {
    val f = Config.stateFile
    if (!f.exists()) return 0 to 0
    return try {
        val s = Json.parseMap(f.readText())
        val ds = (s["disruptions"].asList() ?: emptyList()).map { disruptionFromSaved(it.asMap()!!) }
        val inc = (s["incidents"].asList() ?: emptyList()).map { incidentFromSaved(it.asMap()!!) }
        for (d in ds) disruptions[d.id] = d
        for (i in inc) incidents[i.id] = i
        lastSaved = Json.str(snapshot())
        ds.size to inc.size
    } catch (e: Exception) {
        System.err.println("[sbb-twin] could not restore the saved state: ${e.message}")
        0 to 0
    }
}
