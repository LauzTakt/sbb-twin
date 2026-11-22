package ch.lauzhack.twin

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.request.path
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import java.io.File
import java.net.URLDecoder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private val types = mapOf("html" to "text/html", "js" to "text/javascript", "css" to "text/css", "json" to "application/json", "svg" to "image/svg+xml", "png" to "image/png", "woff2" to "font/woff2")

private fun every(ms: Long, name: String, f: () -> Unit) {
    exec.scheduleWithFixedDelay({ try { f() } catch (e: Throwable) { System.err.println("[sbb-twin] $name: $e") } }, ms, ms, TimeUnit.MILLISECONDS)
}
private val exec = Executors.newScheduledThreadPool(3) { r -> Thread(r).apply { isDaemon = true } }

fun main() {
    Clock.now() // first: a replay replaces the clock before anything reads it
    val (edges, paths) = Geometry.load()
    println("[sbb-twin] track geometry: $edges BAV edges, $paths matched station pairs")
    locked { loadTimetable() }
    if (Live.enabled()) {
        val ok = pollRealtime()
        println("[sbb-twin] GTFS-RT: ${if (ok) "${Live.trips.size} trips" else Live.error}")
    } else System.err.println("[sbb-twin] no OTD_GTFS_RT_KEY: trains follow the planned timetable only")

    startBroker()
    val restored = locked { loadState() }
    if (restored.first + restored.second > 0) println("[sbb-twin] restored ${restored.first} disruptions, ${restored.second} incidents")
    locked {
        for (i in incidents.values) publish("incidents/${i.id}", incidentPayload(i), retain = true, qos = 1)
        for (b in bulletins()) publish("bulletins/${b.id}", obj("v" to 1).also { it.putAll(b.toJson() as Map<String, Any?>) }, retain = true, qos = 1)
    }
    every(2000, "save") { locked { saveState() } }

    val dist = File(Config.viewerDir, "dist").canonicalFile
    embeddedServer(Netty, port = Config.port, host = Config.host) {
        install(WebSockets) { maxFrameSize = 4096 }
        routing {
            api()
            webSocket("/live") { Channel.session(this) }
            webSocket("/mqtt", "mqtt") { mqttProxy(this) }
            webSocket("/mqtt", "mqttv3.1") { mqttProxy(this) }
            get("{path...}") {
                val raw = call.request.path()
                if (raw.startsWith("/api/")) return@get call.respondText("404 Not Found", ContentType.Text.Plain, HttpStatusCode.NotFound)
                val rel = URLDecoder.decode(raw, "UTF-8").trimStart('/')
                var file = File(dist, rel).canonicalFile
                if (!file.path.startsWith(dist.path) || !file.isFile || raw.endsWith("/")) file = File(dist, "index.html")
                if (!file.isFile) return@get call.respondText("viewer not built (run: npx vite build viewer)", ContentType.Text.Plain, HttpStatusCode.NotFound)
                call.respondBytes(file.readBytes(), ContentType.parse(types[file.extension] ?: "application/octet-stream"))
            }
        }
    }.start(wait = false)
    println("[sbb-twin] viewer + API http://${Config.host}:${Config.port}/ · MQTT ${if (Config.mqttUrl.isNotEmpty()) "on ${java.net.URI(Config.mqttUrl).host} (read-only WebSocket proxy at /mqtt)" else "none (MQTT_URL not set)"}")
    locked { event("system", "type" to "system.started") }
    System.getenv("RAIL_REPLAY_SCENARIO")?.takeIf { it.isNotEmpty() }?.let { name ->
        locked { println("[replay] ${(startReplay(name)["upcoming"] as? List<*>)?.size ?: 0} steps to come") }
    }

    // One tick per wall-clock second: every train moves, then everything is published with that timestamp.
    Thread {
        while (true) {
            val t = Math.floorDiv(Clock.now(), 1000L) * 1000
            try {
                locked {
                    replayTick(t)
                    scenarioTick(t)
                    val r = tick(t)
                    recordRemoved(r.removed)
                    publishTick(t, r.removed)
                }
            } catch (e: Throwable) { System.err.println("[sbb-twin] tick failed: $e"); e.printStackTrace() }
            Thread.sleep(Clock.nextTickIn())
        }
    }.apply { name = "tick"; isDaemon = false; start() }
    println("[sbb-twin] ${locked { trains.size }} trains in service")

    every(4000, "planner") { locked { warmPlanner() } }
    every(Config.rtIntervalMs, "realtime") { if (pollRealtime()) locked { applyRealtime() } }
    exec.execute { try { pollAlerts(); if (Config.gtfsSaKey.isNotEmpty()) println("[sbb-twin] service alerts: ${AlertsState.alerts.size} touch the railway") } catch (e: Throwable) { System.err.println("[sbb-twin] alerts: $e") } }
    every(Config.saIntervalMs, "alerts") { pollAlerts() }
    every(60_000, "timetable") { if (locked { loadTimetable() }) locked { event("system", "type" to "system.timetable", "note" to "new service day loaded") } }
}
