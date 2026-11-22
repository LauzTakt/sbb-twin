package ch.lauzhack.twin

import com.fasterxml.jackson.databind.ObjectMapper
import java.io.File
import java.util.zip.GZIPInputStream

/** Track geometry (src/geometry.ts): legs between stops follow the BAV network when a matched path exists. */
class Edge(val id: String, val a: Int, val b: Int, val tracks: Int, val lengthM: Double, val coords: DoubleArray)
class NetNode(val id: String?)
class Span(val ref: Int, val from: Double, var to: Double)

class Path(
    val coords: DoubleArray, // lon,lat pairs
    val cum: DoubleArray, // metres from the start, per vertex
    val len: Double,
    val segEdge: IntArray, // per segment: signed edge ref (edge index + 1, negative when reversed), 0 = none
    val bav: Boolean,
) {
    var spansCache: List<Span>? = null
}

class PointAt(val lon: Double, val lat: Double, val bearing: Double, val edge: Int)

object Geometry {
    var edges: List<Edge> = emptyList()
    var nodes: List<NetNode> = emptyList()
    var paths: Map<String, IntArray> = emptyMap()
    var loaded = false
    private val cache = HashMap<String, Path>()
    private val roads = HashMap<String, Path>()

    fun load(): Pair<Int, Int> {
        val n = File(Config.dataDir, "network.json.gz")
        val p = File(Config.dataDir, "paths.json.gz")
        if (!n.exists() || !p.exists()) return 0 to 0
        val om = ObjectMapper()
        val net = GZIPInputStream(n.inputStream().buffered(1 shl 16)).use { om.readTree(it) }
        nodes = net["nodes"].map { NetNode(if (it[0].isNull) null else it[0].asText()) }
        edges = net["edges"].map { e ->
            val c = e[5]
            val arr = DoubleArray(c.size()) { c[it].asDouble() }
            Edge(e[0].asText(), e[1].asInt(), e[2].asInt(), e[3].asInt(), e[4].asDouble(), arr)
        }
        val pj = GZIPInputStream(p.inputStream().buffered(1 shl 16)).use { om.readTree(it) }
        val m = HashMap<String, IntArray>()
        for ((k, v) in pj.fields()) { val r = v[2]; m[k] = IntArray(r.size()) { r[it].asInt() } }
        paths = m
        loaded = true
        cache.clear()
        adjacency = null
        return edges.size to paths.size
    }

    private var adjacency: Map<Int, MutableList<DoubleArray>>? = null // node -> [next node, edge ref, length]
    private var nodeOf: Map<String, Int>? = null
    fun adj(): Pair<Map<Int, MutableList<DoubleArray>>, Map<String, Int>> {
        if (adjacency == null || nodeOf == null) {
            val a = HashMap<Int, MutableList<DoubleArray>>()
            val no = HashMap<String, Int>()
            nodes.forEachIndexed { i, nn -> nn.id?.let { no[it] = i } }
            edges.forEachIndexed { i, e ->
                for ((x, y) in listOf(e.a to e.b, e.b to e.a)) a.getOrPut(x) { ArrayList() }.add(doubleArrayOf(y.toDouble(), (i + 1).toDouble(), e.lengthM))
            }
            adjacency = a; nodeOf = no
        }
        return adjacency!! to nodeOf!!
    }

    fun pathBetween(a: Stop, b: Stop): Path {
        val key = "${a.id}>${b.id}"
        cache[key]?.let { return it }
        var path: Path? = null
        val entry = paths[key]
        if (loaded && entry != null) {
            val coords = ArrayList<Double>(); val segEdge = ArrayList<Int>()
            for (ref in entry) {
                val e = edges.getOrNull(Math.abs(ref) - 1) ?: continue
                val c = e.coords
                val pts = ArrayList<Double>(c.size)
                if (ref > 0) { var i = 0; while (i < c.size) { pts.add(c[i]); pts.add(c[i + 1]); i += 2 } }
                else { var i = c.size - 2; while (i >= 0) { pts.add(c[i]); pts.add(c[i + 1]); i -= 2 } }
                val start = if (coords.isNotEmpty() && coords[coords.size - 2] == pts[0] && coords[coords.size - 1] == pts[1]) 2 else 0
                var i = start
                while (i < pts.size) {
                    if (coords.isNotEmpty()) segEdge.add(ref)
                    coords.add(pts[i]); coords.add(pts[i + 1])
                    i += 2
                }
            }
            if (coords.size >= 4) path = build(coords.toDoubleArray(), segEdge.toIntArray(), true)
        }
        if (path == null) path = build(doubleArrayOf(a.lon, a.lat, b.lon, b.lat), intArrayOf(0), false)
        cache[key] = path
        return path
    }

    fun roadPath(a: Stop, b: Stop): Path = roads.getOrPut("${a.id}>${b.id}") { build(doubleArrayOf(a.lon, a.lat, b.lon, b.lat), intArrayOf(0), false) }

    fun sectionEdges(a: Stop, b: Stop): MutableSet<Int> {
        val entry = paths["${a.id}>${b.id}"] ?: paths["${b.id}>${a.id}"]
        if (entry != null) return entry.mapTo(HashSet()) { Math.abs(it) }
        return route(a.id, b.id).toMutableSet()
    }

    /** Dijkstra with the TS twin's linear-scan queue (same tie-breaking). */
    private fun route(fromId: String, toId: String): List<Int> {
        if (!loaded) return emptyList()
        val (adjacency, nodeOf) = adj()
        val s = nodeOf[fromId] ?: return emptyList()
        val t = nodeOf[toId] ?: return emptyList()
        val dist = HashMap<Int, Double>(); dist[s] = 0.0
        val prev = HashMap<Int, IntArray>()
        val queue = ArrayList<DoubleArray>(); queue.add(doubleArrayOf(0.0, s.toDouble()))
        while (queue.isNotEmpty()) {
            var best = 0
            for (i in 1 until queue.size) if (queue[i][0] < queue[best][0]) best = i
            val (d, uD) = queue[best]
            val u = uD.toInt()
            queue[best] = queue[queue.size - 1]
            queue.removeAt(queue.size - 1)
            if (u == t) break
            if (d > (dist[u] ?: Double.POSITIVE_INFINITY) || d > 60_000) continue
            for (e in adjacency[u] ?: emptyList()) {
                val v = e[0].toInt(); val ref = e[1].toInt(); val w = e[2]
                val nd = d + w
                if (nd < (dist[v] ?: Double.POSITIVE_INFINITY)) {
                    dist[v] = nd; prev[v] = intArrayOf(u, ref); queue.add(doubleArrayOf(nd, v.toDouble()))
                }
            }
        }
        val out = ArrayList<Int>()
        var v = t
        while (prev.containsKey(v)) { out.add(prev[v]!![1]); v = prev[v]!![0] }
        out.reverse()
        return out
    }

    fun edgesWithin(lat: Double, lon: Double, radiusKm: Double): MutableSet<Int> {
        val out = HashSet<Int>()
        if (!loaded) return out
        val r = radiusKm * 1000
        edges.forEachIndexed { i, e ->
            var k = 0
            while (k < e.coords.size) { if (metres(lon, lat, e.coords[k], e.coords[k + 1]) <= r) { out.add(i + 1); break }; k += 6 }
        }
        return out
    }

    /** GeoJSON MultiLineString of a set of edges, about every 100 m; null when empty. */
    fun edgesGeometry(refs: Set<Int>): Map<String, Any?>? {
        val lines = ArrayList<List<List<Double>>>()
        for (ref in refs) {
            val e = edges.getOrNull(Math.abs(ref) - 1) ?: continue
            val line = ArrayList<List<Double>>()
            var i = 0
            while (i < e.coords.size) {
                if (i % 10 == 0 || i == e.coords.size - 2) line.add(listOf(jsRound(e.coords[i] * 1e5) / 1e5, jsRound(e.coords[i + 1] * 1e5) / 1e5))
                i += 2
            }
            lines.add(line)
        }
        return if (lines.isNotEmpty()) obj("type" to "MultiLineString", "coordinates" to lines) else null
    }

    fun edgeTracks(ref: Int): Int = edges.getOrNull(Math.abs(ref) - 1)?.tracks ?: 2
    fun edgeId(ref: Int): String? = if (ref != 0) edges.getOrNull(Math.abs(ref) - 1)?.id else null

    fun abroadGeoJson(): String = File(Config.dataDir, "abroad-lines.geojson").let { if (it.exists()) it.readText() else """{"type":"FeatureCollection","features":[]}""" }
    fun networkGeoJson(): String = File(Config.dataDir, "network-lines.geojson").let { if (it.exists()) it.readText() else """{"type":"FeatureCollection","features":[]}""" }
}

private const val R = 6_371_008.8
private const val RAD = Math.PI / 180

fun metres(lon1: Double, lat1: Double, lon2: Double, lat2: Double): Double {
    val x = (lon2 - lon1) * RAD * Math.cos(((lat1 + lat2) / 2) * RAD)
    val y = (lat2 - lat1) * RAD
    return Math.sqrt(x * x + y * y) * R
}

private fun build(coords: DoubleArray, segEdge: IntArray, bav: Boolean): Path {
    val n = coords.size / 2
    val cum = DoubleArray(n)
    for (i in 1 until n) cum[i] = cum[i - 1] + metres(coords[2 * i - 2], coords[2 * i - 1], coords[2 * i], coords[2 * i + 1])
    return Path(coords, cum, if (n > 0) cum[n - 1] else 0.0, segEdge, bav)
}

fun travelPath(cat: String, a: Stop, b: Stop): Path = if (cat == "EV") Geometry.roadPath(a, b) else Geometry.pathBetween(a, b)
fun pathBetween(a: Stop, b: Stop) = Geometry.pathBetween(a, b)
fun sectionEdges(a: Stop, b: Stop) = Geometry.sectionEdges(a, b)
fun edgesGeometry(refs: Set<Int>) = Geometry.edgesGeometry(refs)
fun edgesWithin(lat: Double, lon: Double, radiusKm: Double) = Geometry.edgesWithin(lat, lon, radiusKm)
fun edgeTracks(ref: Int) = Geometry.edgeTracks(ref)

fun pointAt(path: Path, s: Double): PointAt {
    val coords = path.coords; val cum = path.cum
    val n = cum.size
    if (n < 2) return PointAt(coords[0], coords[1], 0.0, 0)
    val d = Math.max(0.0, Math.min(path.len, s))
    var lo = 0; var hi = n - 1
    while (hi - lo > 1) { val mid = (lo + hi) shr 1; if (cum[mid] <= d) lo = mid else hi = mid }
    val span = (cum[hi] - cum[lo]).let { if (it == 0.0) 1.0 else it }
    val f = (d - cum[lo]) / span
    val x1 = coords[2 * lo]; val y1 = coords[2 * lo + 1]; val x2 = coords[2 * hi]; val y2 = coords[2 * hi + 1]
    val bearing = ((Math.atan2((x2 - x1) * Math.cos(y1 * RAD), y2 - y1) / RAD + 360) % 360)
    return PointAt(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, bearing, path.segEdge.getOrElse(lo) { 0 })
}

fun edgeSpans(path: Path): List<Span> {
    path.spansCache?.let { return it }
    val spans = ArrayList<Span>()
    for (i in path.segEdge.indices) {
        val ref = path.segEdge[i]
        val last = spans.lastOrNull()
        if (last != null && last.ref == ref) last.to = path.cum[i + 1] else spans.add(Span(ref, path.cum[i], path.cum[i + 1]))
    }
    path.spansCache = spans
    return spans
}
