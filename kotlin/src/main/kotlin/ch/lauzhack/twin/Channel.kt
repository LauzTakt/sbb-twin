package ch.lauzhack.twin

import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.channels.Channel as KChannel
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/** The control page's own link to the twin: WebSocket /live fed straight from the engine's state (src/channel.ts). */
object Channel {
    private class Page(val queue: KChannel<String> = KChannel(2048)) { @Volatile var watch: String? = null }
    private val pages: MutableSet<Page> = ConcurrentHashMap.newKeySet()
    private val last = LinkedHashMap<String, String>() // latest message per key, replayed to a page that connects
    private val recent = ArrayList<String>() // latest events, newest first
    private val lock = Any()

    suspend fun session(s: DefaultWebSocketServerSession) {
        val page = Page()
        synchronized(lock) {
            for (m in last.values) page.queue.trySend(m)
            page.queue.trySend("{\"type\":\"events\",\"events\":[${recent.joinToString(",")}]}")
            pages.add(page)
        }
        val writer = s.launch { for (m in page.queue) s.outgoing.send(Frame.Text(m)) }
        try {
            for (f in s.incoming) {
                if (f !is Frame.Text) continue
                val m = Json.parseMap(f.readText())
                if (m.containsKey("watch")) page.watch = m["watch"] as? String
            }
        } catch (_: Exception) {
        } finally {
            pages.remove(page); page.queue.close(); writer.cancel()
        }
    }

    /** To every page. With a key the message is also kept and replayed to pages that connect later. */
    fun send(key: String?, msg: Any?, droppable: Boolean = false) {
        val s = Json.str(msg)
        if (key != null) synchronized(lock) { last[key] = s }
        for (p in pages) p.queue.trySend(s)
    }
    fun sendEvent(ev: Any?) {
        val s = Json.str(ev)
        synchronized(lock) { recent.add(0, s); if (recent.size > 80) recent.removeAt(recent.size - 1) }
        val m = "{\"type\":\"event\",\"event\":$s}"
        for (p in pages) p.queue.trySend(m)
    }
    fun watched(): Set<String> = pages.mapNotNull { it.watch }.toSet()
    fun sendToWatchers(trainId: String, msg: Any?) {
        val s = Json.str(msg)
        for (p in pages) if (p.watch == trainId) p.queue.trySend(s)
    }
    fun pageCount() = pages.size
}
