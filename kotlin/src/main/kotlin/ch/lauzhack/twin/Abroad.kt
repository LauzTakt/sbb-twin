package ch.lauzhack.twin

import com.fasterxml.jackson.databind.ObjectMapper
import java.io.File

/** A route along the railway between two points over the Swiss network joined to the railways abroad (src/abroad.ts). */
class AbroadGraph(val lon: List<Double>, val lat: List<Double>, val adj: List<MutableList<Pair<Int, Double>>>, val grid: Map<String, List<Int>>)

private const val CELL = 0.01
private fun nodeKey(lon: Double, lat: Double) = "${jsRoundL(lon * 2e4)}:${jsRoundL(lat * 2e4)}"
private fun cellKey(lon: Double, lat: Double) = "${Math.floor(lon / CELL).toLong()}:${Math.floor(lat / CELL).toLong()}"
private fun km(a: Double, b: Double, c: Double, d: Double) = Math.hypot((a - c) * 76, (b - d) * 111)

/** layers: [swiss lines, abroad lines]; a line is a list of [lon, lat] points. */
fun buildAbroadGraph(layers: List<List<List<DoubleArray>>>): AbroadGraph {
    val ids = HashMap<String, Int>()
    val lon = ArrayList<Double>(); val lat = ArrayList<Double>()
    val adj = ArrayList<MutableList<Pair<Int, Double>>>()
    fun node(p: DoubleArray): Int {
        val k = nodeKey(p[0], p[1])
        return ids.getOrPut(k) { lon.add(p[0]); lat.add(p[1]); adj.add(ArrayList()); lon.size - 1 }
    }
    val ends = ArrayList<Int>(); val swiss = HashSet<Int>(); val abroadEnds = ArrayList<Int>()
    layers.forEachIndexed { which, lines ->
        for (c in lines) {
            if (c.size < 2) continue
            var prev = node(c[0])
            ends.add(prev)
            if (which == 0) swiss.add(prev) else abroadEnds.add(prev)
            for (i in 1 until c.size) {
                val cur = node(c[i])
                if (which == 0) swiss.add(cur)
                if (cur != prev) {
                    val w = km(lon[prev], lat[prev], lon[cur], lat[cur])
                    adj[prev].add(cur to w); adj[cur].add(prev to w)
                }
                prev = cur
            }
            ends.add(prev)
            if (which == 1) abroadEnds.add(prev)
        }
    }
    val grid = HashMap<String, MutableList<Int>>()
    for (i in lon.indices) grid.getOrPut(cellKey(lon[i], lat[i])) { ArrayList() }.add(i)
    for (e in ends) {
        val cx = Math.floor(lon[e] / CELL).toLong(); val cy = Math.floor(lat[e] / CELL).toLong()
        for (dx in -1..1) for (dy in -1..1) for (o in grid["${cx + dx}:${cy + dy}"] ?: emptyList()) {
            if (o == e) continue
            val w = km(lon[e], lat[e], lon[o], lat[o])
            if (w < 0.06 && adj[e].none { it.first == o }) { adj[e].add(o to w); adj[o].add(e to w) }
        }
    }
    for (e in abroadEnds) {
        val cx = Math.floor(lon[e] / CELL).toLong(); val cy = Math.floor(lat[e] / CELL).toLong()
        var best = -1; var bd = 0.45
        for (dx in -1..1) for (dy in -1..1) for (o in grid["${cx + dx}:${cy + dy}"] ?: emptyList()) {
            if (o !in swiss) continue
            val d = km(lon[e], lat[e], lon[o], lat[o])
            if (d < bd) { bd = d; best = o }
        }
        if (best >= 0) { adj[e].add(best to bd); adj[best].add(e to bd) }
    }
    return AbroadGraph(lon, lat, adj, grid)
}

private fun nearest(g: AbroadGraph, lo: Double, la: Double, maxKm: Double): Int {
    var best = -1; var bd = maxKm
    val r = Math.ceil(maxKm / 1.0).toInt() + 1
    val cx = Math.floor(lo / CELL).toLong(); val cy = Math.floor(la / CELL).toLong()
    for (dx in -r..r) for (dy in -r..r) for (i in g.grid["${cx + dx}:${cy + dy}"] ?: emptyList()) {
        val d = km(lo, la, g.lon[i], g.lat[i])
        if (d < bd) { bd = d; best = i }
    }
    return best
}

/** Binary heap with the TS twin's exact sift rules (same tie-breaking). */
private class Heap {
    val h = ArrayList<DoubleArray>()
    fun push(x: DoubleArray) {
        h.add(x); var i = h.size - 1
        while (i > 0) { val p = (i - 1) shr 1; if (h[p][0] <= h[i][0]) break; val t = h[p]; h[p] = h[i]; h[i] = t; i = p }
    }
    fun pop(): DoubleArray {
        val top = h[0]; val last = h.removeAt(h.size - 1)
        if (h.isNotEmpty()) {
            h[0] = last; var i = 0
            while (true) {
                val l = 2 * i + 1; val r = l + 1; var m = i
                if (l < h.size && h[l][0] < h[m][0]) m = l
                if (r < h.size && h[r][0] < h[m][0]) m = r
                if (m == i) break
                val t = h[m]; h[m] = h[i]; h[i] = t; i = m
            }
        }
        return top
    }
    fun isNotEmpty() = h.isNotEmpty()
}

fun abroadRoute(g: AbroadGraph, a: DoubleArray, b: DoubleArray): List<List<Double>>? {
    val s = nearest(g, a[0], a[1], 4.0); val t = nearest(g, b[0], b[1], 4.0)
    if (s < 0 || t < 0) return null
    val dist = HashMap<Int, Double>(); dist[s] = 0.0
    val prev = HashMap<Int, Int>()
    val heap = Heap(); heap.push(doubleArrayOf(0.0, s.toDouble()))
    while (heap.isNotEmpty()) {
        val top = heap.pop(); val d = top[0]; val u = top[1].toInt()
        if (u == t) break
        if (d > (dist[u] ?: Double.POSITIVE_INFINITY)) continue
        for ((v, w) in g.adj[u]) {
            val nd = d + w
            if (nd < (dist[v] ?: Double.POSITIVE_INFINITY)) { dist[v] = nd; prev[v] = u; heap.push(doubleArrayOf(nd, v.toDouble())) }
        }
    }
    if (!dist.containsKey(t)) return null
    val direct = km(a[0], a[1], b[0], b[1])
    if (dist[t]!! > Math.max(direct * 3, direct + 15)) return null
    val path = ArrayList<List<Double>>()
    var u: Int? = t
    while (u != null) { path.add(listOf(jsRound(g.lon[u] * 1e5) / 1e5, jsRound(g.lat[u] * 1e5) / 1e5)); u = prev[u] }
    path.reverse()
    return path
}

private var graph: AbroadGraph? = null
private var graphLoaded = false
private fun loadGraph(): AbroadGraph? {
    val files = listOf("network-lines.geojson", "abroad-lines.geojson").map { File(Config.dataDir, it) }
    if (!files.all { it.exists() }) return null
    val om = ObjectMapper()
    val layers = files.map { f ->
        val out = ArrayList<List<DoubleArray>>()
        for (feat in om.readTree(f)["features"]) {
            val g = feat["geometry"]; val c = g["coordinates"]
            val lines = when (g["type"].asText()) { "LineString" -> listOf(c); "MultiLineString" -> c.toList(); else -> emptyList() }
            for (line in lines) out.add(line.map { doubleArrayOf(it[0].asDouble(), it[1].asDouble()) })
        }
        out
    }
    return buildAbroadGraph(layers)
}

/** The foreign railway between two points as lon/lat pairs (null when none is close enough or connected). */
@Synchronized
fun abroadRoute(a: Stop, b: Stop): List<List<Double>>? {
    if (!graphLoaded) { graph = loadGraph(); graphLoaded = true }
    val g = graph ?: return null
    return abroadRoute(g, doubleArrayOf(a.lon, a.lat), doubleArrayOf(b.lon, b.lat))
}
