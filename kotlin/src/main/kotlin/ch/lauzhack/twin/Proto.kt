package ch.lauzhack.twin

/** Minimal protobuf wire-format reader (no library): enough for GTFS-RT FeedMessages. */
class ProtoField(val number: Int, val wire: Int, val varint: Long, val bytes: ByteArray?) {
    fun string() = String(bytes ?: ByteArray(0), Charsets.UTF_8)
    fun message(): List<ProtoField> = Proto.parse(bytes ?: ByteArray(0))
}

object Proto {
    /** All fields of one message, in order. Truncated or malformed input throws IllegalArgumentException. */
    fun parse(buf: ByteArray): List<ProtoField> {
        val out = ArrayList<ProtoField>()
        var p = 0
        fun varint(): Long {
            var shift = 0; var r = 0L
            while (true) {
                if (p >= buf.size) throw IllegalArgumentException("truncated varint")
                val b = buf[p++].toInt() and 0xff
                r = r or ((b and 0x7f).toLong() shl shift)
                if (b and 0x80 == 0) return r
                shift += 7
                if (shift > 63) throw IllegalArgumentException("varint too long")
            }
        }
        while (p < buf.size) {
            val tag = varint()
            val num = (tag ushr 3).toInt(); val wire = (tag and 7).toInt()
            when (wire) {
                0 -> out.add(ProtoField(num, wire, varint(), null))
                1 -> { if (p + 8 > buf.size) throw IllegalArgumentException("truncated"); out.add(ProtoField(num, wire, 0, buf.copyOfRange(p, p + 8))); p += 8 }
                2 -> { val len = varint().toInt(); if (len < 0 || p + len > buf.size) throw IllegalArgumentException("truncated"); out.add(ProtoField(num, wire, 0, buf.copyOfRange(p, p + len))); p += len }
                5 -> { if (p + 4 > buf.size) throw IllegalArgumentException("truncated"); out.add(ProtoField(num, wire, 0, buf.copyOfRange(p, p + 4))); p += 4 }
                else -> throw IllegalArgumentException("unsupported wire type $wire")
            }
        }
        return out
    }
}

fun List<ProtoField>.first(n: Int) = firstOrNull { it.number == n }
fun List<ProtoField>.all(n: Int) = filter { it.number == n }
