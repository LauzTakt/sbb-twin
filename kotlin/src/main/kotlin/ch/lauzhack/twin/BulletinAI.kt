package ch.lauzhack.twin

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.MessageDigest
import java.text.Normalizer
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

/** Bulletin wording by Claude Haiku, behind a safety net (src/bulletinAI.ts). The template text stands unless the
 *  answer passes validate(). */
class BulletinFacts(
    val state: String, val sectionA: String, val sectionB: String?, val cause: String, val durationType: String, val until: String?,
    val lines: List<String>, val noTrains: Boolean, val oneTrackKmh: Int?, val replacementBus: String?, val busStops: List<String>,
) : JsonLike {
    override fun toJson() = obj(
        "state" to state, "section" to obj("a" to sectionA, "b" to sectionB), "cause" to cause, "durationType" to durationType, "until" to until,
        "lines" to lines, "noTrains" to noTrains, "oneTrackKmh" to oneTrackKmh, "replacementBus" to replacementBus, "busStops" to busStops,
    )
}
class Written(val text: String, val source: String, val errors: List<String>)

private val LANGS = listOf("en", "de", "fr", "it")
private val LANG_NAME = mapOf("en" to "English", "de" to "German", "fr" to "French", "it" to "Italian")

private val examples: Map<String, List<Map<String, String>>> by lazy {
    val s = BulletinFacts::class.java.getResourceAsStream("/bulletin-examples.json")!!.readBytes().toString(Charsets.UTF_8)
    @Suppress("UNCHECKED_CAST")
    (Json.parse(s) as Map<String, List<Map<String, String>>>)
}

fun aiEnabled() = Config.anthropicKey.isNotEmpty()

private fun esc(s: String) = Regex.escape(s)
private fun fold(s: String) = Normalizer.normalize(s, Normalizer.Form.NFC)
private val LINE_RE = Regex("\\b(?:ICE|ICN|IC|IRE|IR|EC|EN|NJ|RJX|TGV|RE|SN|S|R|PE)\\s?\\d{1,3}\\b")
private val PLATFORM_RE = Regex("\\b(?:platform|plattform|gleis\\s*\\d|perron|quai|voie\\s*\\d|binario\\s*\\d|marciapiede|sektor|sector)\\b", RegexOption.IGNORE_CASE)
private val DIVERT = Regex("divers|umleitung|d[eé]viation|deviazion", RegexOption.IGNORE_CASE)

/** Why an answer cannot be published (empty list: it can). */
fun validate(text: String, facts: BulletinFacts, template: String): List<String> {
    val errors = ArrayList<String>()
    val t = fold(text.trim())
    if (t.isEmpty()) return listOf("empty")
    if (t.split("\n").size != template.split("\n").size) errors.add("line structure: ${t.split("\n").size} lines, expected ${template.split("\n").size}")
    if (DIVERT.containsMatchIn(t) && !DIVERT.containsMatchIn(template)) errors.add("invented diversions")
    for (l in facts.lines) if (!Regex("(^|[^A-Za-z0-9])${esc(l)}([^A-Za-z0-9]|$)").containsMatchIn(t)) errors.add("missing line $l")
    val ends = listOfNotNull(facts.sectionA, facts.sectionB)
    val stations = ends + (if (facts.replacementBus == "running") facts.busStops else emptyList())
    for (s in ends) if (!t.contains(fold(s))) errors.add("missing station $s")
    if (facts.until != null && facts.durationType != "UNKNOWN" && facts.state != "resumed" && !t.contains(facts.until)) errors.add("missing time ${facts.until}")
    for (m in Regex("\\b\\d{1,2}[:.]\\d{2}\\b").findAll(t)) if (m.value.replace(".", ":") != facts.until) errors.add("invented time ${m.value}")
    for (m in LINE_RE.findAll(t)) { val l = m.value.replace(Regex("\\s"), ""); if (!facts.lines.contains(l)) errors.add("invented line ${m.value}") }
    val allowed = Json.str(facts) + template
    for (n in Regex("\\d+").findAll(t)) if (!allowed.contains(n.value)) errors.add("invented number ${n.value}")
    if (PLATFORM_RE.containsMatchIn(t)) errors.add("mentions a platform")
    val known = stations.map { fold(it) }
    for (s in stops) {
        if (s.name.length < 6 || known.any { it.contains(s.name) || s.name.contains(it) }) continue
        if (t.contains(s.name) && Regex("(^|[^\\p{L}])${esc(s.name)}([^\\p{L}]|$)").containsMatchIn(t)) { errors.add("invented station ${s.name}"); break }
    }
    return errors
}

private fun prompt(facts: BulletinFacts, template: String, lang: String): Pair<String, String> {
    val kind = if (facts.state == "resumed") "resumed" else if (facts.state == "limited") "limited" else if (facts.replacementBus == "running") "interrupted_bus" else "interrupted"
    val shots = examples[kind]!!.mapIndexed { i, e -> "Example ${i + 1}:\n${e[lang]}" }.joinToString("\n\n")
    val ln = LANG_NAME[lang]
    val system = listOf(
        "You write the public text of an SBB rail disruption bulletin in $ln, in the style of the real SBB examples.",
        "Rewrite the draft so it reads like the examples. Keep exactly one output line per draft line, in the same order, each line saying what its draft line says.",
        "Use only the facts given. Keep every station name, line name and time exactly as written. Do not add stations, lines, times, numbers, platforms, routes, reasons or advice that are not in the facts.",
        "Write grammatical, natural $ln. The examples are partly machine-translated: keep their structure and tone, never a grammar mistake.",
        "Answer with the bulletin text only: no title, no quotes, no comments.",
    ).joinToString("\n")
    val user = "Real SBB bulletins of the same kind ($ln):\n\n$shots\n\nFacts (JSON):\n${Json.str(facts)}\n\nDraft (English, ${template.split("\n").size} lines):\n$template"
    return system to user
}

private val cache = ConcurrentHashMap<String, Written>()
private var calls = 0
@Volatile private var lastError: String? = null
private val http by lazy { HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build() }

private fun sha1(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

/** The bulletin text for these facts: Haiku's when it passes validation within the timeout, else the template. Blocking. */
fun writeBulletin(facts: BulletinFacts, template: String, lang: String = "en", timeoutMs: Long = Config.bulletinTimeoutMs): Written {
    if (Config.anthropicKey.isEmpty()) return Written(template, "template", listOf("no key"))
    val key = sha1("$lang|$template|${Json.str(facts)}")
    cache[key]?.let { return it }
    val (system, user) = prompt(facts, template, lang)
    var timedOut = false
    val out: Written = try {
        calls++
        val body = Json.str(obj("model" to Config.bulletinModel, "max_tokens" to 1024, "thinking" to obj("type" to "disabled"), "system" to system, "messages" to listOf(obj("role" to "user", "content" to user))))
        val req = HttpRequest.newBuilder(URI.create("https://api.anthropic.com/v1/messages")).timeout(Duration.ofMillis(timeoutMs))
            .header("content-type", "application/json").header("x-api-key", Config.anthropicKey).header("anthropic-version", "2026-10-21")
            .POST(HttpRequest.BodyPublishers.ofString(body)).build()
        val res = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (res.statusCode() !in 200..299) throw RuntimeException("HTTP ${res.statusCode()}")
        val b = Json.parseMap(res.body())
        val stop = b["stop_reason"] as? String
        if (stop != null && stop != "end_turn") throw RuntimeException("stop $stop")
        val text = (b["content"].asList() ?: emptyList()).mapNotNull { it.asMap() }.filter { it["type"] == "text" }.joinToString("") { it["text"] as? String ?: "" }
            .trim().replace("\r", "").replace(Regex("\n{2,}"), "\n")
        val errors = validate(text, facts, template)
        if (errors.isNotEmpty()) Written(template, "template", errors) else Written(text, "ai", emptyList())
    } catch (e: java.net.http.HttpTimeoutException) {
        timedOut = true; Written(template, "template", listOf("timeout"))
    } catch (e: Exception) {
        Written(template, "template", listOf(e.message ?: e.javaClass.simpleName))
    }
    if (out.source == "ai" || out.errors.firstOrNull() != "timeout") cache[key] = out
    lastError = if (out.source == "template") out.errors.take(3).joinToString("; ") else null
    if (out.source == "template") System.err.println("[bulletin] $lang kept the template: ${out.errors.take(3).joinToString("; ")}")
    return out
}
fun aiStats() = obj("enabled" to aiEnabled(), "model" to Config.bulletinModel, "calls" to calls, "cached" to cache.size, "lastError" to lastError)
