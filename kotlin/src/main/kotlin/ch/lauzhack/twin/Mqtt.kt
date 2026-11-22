package ch.lauzhack.twin

import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readBytes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.MqttAsyncClient
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttClient
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Where the twin publishes (src/mqtt.ts). MQTT_URL set: the team broker, plus a read-only WebSocket proxy at /mqtt.
 *  MQTT_URL blank: nothing is sent (no embedded broker); the status still reports mode "embedded". */
class BrokerStats { @Volatile var mode = if (Config.mqttUrl.isNotEmpty()) "external" else "embedded"; @Volatile var connected = false; @Volatile var clients = 0 }
val brokerStats = BrokerStats()
val OPEN_NAMESPACES = listOf("detections/", "ext/")
fun topic(path: String) = "${Config.topicRoot}/$path"

private var upstream: MqttAsyncClient? = null
private val retained = ConcurrentHashMap<String, ByteArray>()
private val published: MutableSet<String> = ConcurrentHashMap.newKeySet()

private fun paho(url: String): String {
    val u = URI(url)
    val scheme = when (u.scheme) { "mqtt", "tcp" -> "tcp"; "mqtts", "ssl" -> "ssl"; else -> u.scheme }
    val port = if (u.port > 0) u.port else if (scheme == "ssl") 8883 else 1883
    return "$scheme://${u.host}:$port"
}
private fun options() = MqttConnectOptions().apply {
    isCleanSession = true; isAutomaticReconnect = true; connectionTimeout = 10; keepAliveInterval = 60; maxInflight = 10_000
    Config.mqttUsername?.let { userName = it }
    Config.mqttPassword?.let { password = it.toCharArray() }
}
private fun clientId(prefix: String) = prefix + java.util.UUID.randomUUID().toString().take(6)

/** Connect to the team broker (waits up to 8 s for the first connection, then keeps trying in the background). */
fun startBroker() {
    if (Config.mqttUrl.isEmpty()) { brokerStats.connected = true; return }
    val host = URI(Config.mqttUrl).host
    val client = MqttAsyncClient(paho(Config.mqttUrl), clientId("sbb-twin-"), MemoryPersistence())
    client.setCallback(object : MqttCallbackExtended {
        override fun connectComplete(reconnect: Boolean, serverURI: String?) {
            brokerStats.connected = true
            println("[sbb-twin] publishing to $host under ${Config.topicRoot}/")
            for ((t, body) in retained) runCatching { client.publish(t, body, 1, true) }
        }
        override fun connectionLost(cause: Throwable?) { brokerStats.connected = false }
        override fun messageArrived(topic: String?, message: MqttMessage?) {}
        override fun deliveryComplete(token: IMqttDeliveryToken?) {}
    })
    upstream = client
    val first = CountDownLatch(1)
    Thread {
        while (!client.isConnected) {
            try { client.connect(options()).waitForCompletion(15_000) }
            catch (e: Exception) { System.err.println("[sbb-twin] MQTT broker: ${e.message}"); Thread.sleep(2000) }
        }
        first.countDown()
    }.apply { isDaemon = true; start() }
    first.await(8, TimeUnit.SECONDS)
    Thread { sweepStale() }.apply { isDaemon = true; start() }
}

/** The team broker keeps retained messages across restarts: remove ours that this run no longer publishes. */
private fun sweepStale() {
    val found: MutableSet<String> = ConcurrentHashMap.newKeySet()
    try {
        val peek = MqttClient(paho(Config.mqttUrl), clientId("sbb-twin-sweep-"), MemoryPersistence())
        peek.setCallback(object : MqttCallbackExtended {
            override fun connectComplete(reconnect: Boolean, serverURI: String?) {}
            override fun connectionLost(cause: Throwable?) {}
            override fun messageArrived(topic: String, m: MqttMessage) { if (m.isRetained && m.payload.isNotEmpty()) found.add(topic) }
            override fun deliveryComplete(token: IMqttDeliveryToken?) {}
        })
        peek.connect(options().apply { isAutomaticReconnect = false })
        peek.subscribe("${Config.topicRoot}/#")
        Thread.sleep(5000)
        peek.disconnectForcibly(); peek.close()
    } catch (_: Exception) {}
    Thread.sleep(60_000)
    var n = 0
    for (t in found) if (t !in published && OPEN_NAMESPACES.none { t.startsWith(topic(it)) } && upstream?.isConnected == true) {
        runCatching { upstream!!.publish(t, ByteArray(0), 1, true); n++ }
    }
    if (n > 0) println("[sbb-twin] removed $n stale retained messages from an earlier run")
}

fun publish(path: String, payload: Any?, retain: Boolean = false, qos: Int = 0) {
    val t = topic(path)
    val body = if (payload == null) ByteArray(0) else if (payload is String) payload.toByteArray() else Json.bytes(payload)
    if (retain) {
        published.add(t)
        if (body.isNotEmpty()) retained[t] = body else retained.remove(t)
    }
    val c = upstream ?: return
    if (c.isConnected) try { c.publish(t, body, qos, retain) } catch (_: Exception) {}
}
/** Remove a retained message (consumers receive an empty payload). */
fun clear(path: String) = publish(path, null, retain = true, qos = 1)

// ---------------------------------------------------------------- MQTT 3.1.1 packets for the read-only proxy
/** Splits a byte stream into whole MQTT packets. */
class MqttStreamParser {
    private var buf = ByteArray(0)
    fun feed(chunk: ByteArray): List<ByteArray> {
        buf += chunk
        val out = ArrayList<ByteArray>()
        var pos = 0
        while (true) {
            if (buf.size - pos < 2) break
            var mult = 1; var len = 0; var i = pos + 1; var ok = false
            while (i < buf.size && i <= pos + 4) {
                val b = buf[i].toInt() and 0xFF
                len += (b and 0x7F) * mult; mult *= 128; i++
                if (b and 0x80 == 0) { ok = true; break }
            }
            if (!ok) { if (i > pos + 4) throw IllegalArgumentException("bad remaining length"); break }
            if (buf.size - i < len) break
            out.add(buf.copyOfRange(pos, i + len))
            pos = i + len
        }
        buf = buf.copyOfRange(pos, buf.size)
        return out
    }
}
fun mqttRemainingLength(n: Int): ByteArray {
    val o = ByteArrayOutputStream(); var x = n
    do { var b = x % 128; x /= 128; if (x > 0) b = b or 0x80; o.write(b) } while (x > 0)
    return o.toByteArray()
}
private fun body(p: ByteArray): ByteArray { var i = 1; while (p[i].toInt() and 0x80 != 0) i++; return p.copyOfRange(i + 1, p.size) }
private fun frame(first: Int, b: ByteArray): ByteArray = byteArrayOf(first.toByte()) + mqttRemainingLength(b.size) + b
private fun u16(b: ByteArray, at: Int) = ((b[at].toInt() and 0xFF) shl 8) or (b[at + 1].toInt() and 0xFF)
private fun utf(s: ByteArray) = byteArrayOf((s.size shr 8).toByte(), s.size.toByte()) + s

/** A CONNECT packet with the broker credentials set (3.1.1 / 3.1; null for other protocol levels). */
fun mqttConnectWithCredentials(packet: ByteArray, username: String?, password: String?): ByteArray? {
    val b = body(packet)
    var i = 0
    val nameLen = u16(b, i); i += 2 + nameLen
    val level = b[i].toInt(); i++
    if (level != 4 && level != 3) return null
    val flags = b[i].toInt() and 0xFF; i++
    val keep = b.copyOfRange(i, i + 2); i += 2
    val head = b.copyOfRange(0, 2 + nameLen)
    var j = i
    fun field(): ByteArray { val n = u16(b, j); val r = b.copyOfRange(j, j + 2 + n); j += 2 + n; return r }
    val clientId = field()
    var will = ByteArray(0)
    if (flags and 0x04 != 0) { will = field() + field() }
    if (flags and 0x80 != 0) field()
    if (flags and 0x40 != 0) field()
    var nf = flags and 0x3E
    var tail = ByteArray(0)
    if (username != null) { nf = nf or 0x80; tail += utf(username.toByteArray()) }
    if (username != null) { nf = nf or 0x40; tail += utf((password ?: "").toByteArray()) }
    return frame(0x10, head + byteArrayOf(level.toByte(), nf.toByte()) + keep + clientId + will + tail)
}
/** Topic filters of a SUBSCRIBE packet and its message id. */
fun mqttSubscribeTopics(packet: ByteArray): Pair<Int, List<String>> {
    val b = body(packet)
    val id = u16(b, 0); var i = 2
    val topics = ArrayList<String>()
    while (i < b.size) { val n = u16(b, i); topics.add(String(b, i + 2, n, Charsets.UTF_8)); i += 2 + n + 1 }
    return id to topics
}
fun mqttSuback(messageId: Int, count: Int): ByteArray = frame(0x90, byteArrayOf((messageId shr 8).toByte(), messageId.toByte()) + ByteArray(count) { 0x80.toByte() })

/** Browser <-WebSocket-> here <-TCP-> team broker: credentials added here, read-only, limited to our topic root. */
suspend fun mqttProxy(session: DefaultWebSocketServerSession) {
    if (Config.mqttUrl.isEmpty()) { session.close(CloseReason(CloseReason.Codes.NORMAL, "no broker")); return }
    val target = URI(Config.mqttUrl)
    brokerStats.clients++
    val tcp = Socket()
    try {
        withContext(Dispatchers.IO) { tcp.connect(InetSocketAddress(target.host, if (target.port > 0) target.port else 1883), 10_000) }
        val reader = session.launch(Dispatchers.IO) {
            val buf = ByteArray(16384)
            try { while (true) { val n = tcp.getInputStream().read(buf); if (n < 0) break; session.outgoing.send(Frame.Binary(true, buf.copyOf(n))) } } catch (_: Exception) {}
            runCatching { session.close() }
        }
        val parser = MqttStreamParser()
        val out = tcp.getOutputStream()
        for (f in session.incoming) {
            if (f !is Frame.Binary) continue
            for (p in parser.feed(f.readBytes())) {
                when ((p[0].toInt() and 0xF0) shr 4) {
                    1 -> { val c = mqttConnectWithCredentials(p, Config.mqttUsername, Config.mqttPassword) ?: throw IllegalStateException("unsupported"); withContext(Dispatchers.IO) { out.write(c); out.flush() } }
                    3 -> {}
                    8 -> {
                        val (id, topics) = mqttSubscribeTopics(p)
                        if (topics.any { !it.startsWith("${Config.topicRoot}/") }) session.outgoing.send(Frame.Binary(true, mqttSuback(id, topics.size)))
                        else withContext(Dispatchers.IO) { out.write(p); out.flush() }
                    }
                    else -> withContext(Dispatchers.IO) { out.write(p); out.flush() }
                }
            }
        }
        reader.cancel()
    } catch (_: Exception) {
    } finally {
        brokerStats.clients = maxOf(0, brokerStats.clients - 1)
        runCatching { tcp.close() }
    }
}
