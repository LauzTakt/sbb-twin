package ch.lauzhack.twin

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.databind.ObjectMapper
import java.io.StringWriter

/** JSON helpers. Payloads are plain Kotlin values: Map<String, Any?>, List, Array, numbers, String, Boolean, null.
 *  Numbers print like JavaScript (3.0 -> 3, NaN/Infinity -> null). Objects with `toJson()` (JsonLike) are expanded. */
interface JsonLike { fun toJson(): Any? }

object Json {
    private val mapper = ObjectMapper()

    fun parse(s: String): Any? = mapper.readValue(s, Any::class.java)
    fun parseMap(s: String): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return (runCatching { parse(s) }.getOrNull() as? Map<String, Any?>) ?: emptyMap()
    }

    fun str(x: Any?): String {
        val w = StringWriter(256)
        mapper.factory.createGenerator(w).use { write(it, x) }
        return w.toString()
    }
    fun bytes(x: Any?): ByteArray = str(x).toByteArray(Charsets.UTF_8)

    /** JS-like number text: integers without a fraction, no exponent below 1e21. */
    fun num(d: Double): String {
        if (d.isNaN() || d.isInfinite()) return "null"
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return d.toLong().toString()
        val s = d.toString()
        if (!s.contains('E')) return s
        return java.math.BigDecimal(s).toPlainString().let { if (it.contains('.')) it.trimEnd('0').trimEnd('.') else it }
    }

    private fun write(g: JsonGenerator, x: Any?) {
        when (x) {
            null -> g.writeNull()
            is String -> g.writeString(x)
            is Boolean -> g.writeBoolean(x)
            is Int -> g.writeNumber(x)
            is Long -> g.writeNumber(x)
            is Double -> if (x.isNaN() || x.isInfinite()) g.writeNull() else g.writeRawValue(num(x))
            is Float -> write(g, x.toDouble())
            is Number -> g.writeNumber(x.toString())
            is JsonLike -> write(g, x.toJson())
            is Map<*, *> -> { g.writeStartObject(); for ((k, v) in x) { if (v is Undefined) continue; g.writeFieldName(k.toString()); write(g, v) }; g.writeEndObject() }
            is Iterable<*> -> { g.writeStartArray(); for (v in x) write(g, v); g.writeEndArray() }
            is Array<*> -> { g.writeStartArray(); for (v in x) write(g, v); g.writeEndArray() }
            is DoubleArray -> { g.writeStartArray(); for (v in x) write(g, v); g.writeEndArray() }
            is IntArray -> { g.writeStartArray(); for (v in x) g.writeNumber(v); g.writeEndArray() }
            is Enum<*> -> g.writeString(x.name)
            else -> g.writeString(x.toString())
        }
    }
}

/** A value that is left out of a JSON object (like `undefined` in JavaScript). */
object Undefined

/** Build a JSON object from pairs, dropping Undefined values. */
fun obj(vararg pairs: Pair<String, Any?>): LinkedHashMap<String, Any?> {
    val m = LinkedHashMap<String, Any?>(pairs.size * 2)
    for ((k, v) in pairs) if (v !== Undefined) m[k] = v
    return m
}

// small coercions for parsed JSON (numbers arrive as Int/Long/Double)
fun Any?.asDouble(): Double? = when (this) { is Number -> toDouble(); is String -> toDoubleOrNull(); else -> null }
fun Any?.asLong(): Long? = when (this) { is Number -> toLong(); is String -> toDoubleOrNull()?.toLong(); else -> null }
@Suppress("UNCHECKED_CAST") fun Any?.asMap(): Map<String, Any?>? = this as? Map<String, Any?>
@Suppress("UNCHECKED_CAST") fun Any?.asList(): List<Any?>? = this as? List<Any?>

/** JS Number(x) for a JSON-ish value: undefined/null -> NaN/0 rules simplified (null -> 0, blank -> 0, junk -> NaN). */
fun jsNumber(x: Any?): Double = when (x) {
    null -> 0.0
    is Number -> x.toDouble()
    is Boolean -> if (x) 1.0 else 0.0
    is String -> if (x.isBlank()) 0.0 else x.trim().toDoubleOrNull() ?: Double.NaN
    else -> Double.NaN
}
