package ch.lauzhack.twin

import java.io.File

/** Environment configuration, same variables as the TypeScript twin (src/config.ts). */
object Config {
    private val fileEnv: Map<String, String> = run {
        val f = File(System.getenv("RAIL_ENV_FILE") ?: "${System.getProperty("user.home")}/.config/lauzhack/.env")
        val out = HashMap<String, String>()
        if (f.exists()) for (line in f.readLines()) {
            val m = Regex("^([A-Z0-9_]+)=(.*)$").find(line) ?: continue
            out[m.groupValues[1]] = m.groupValues[2].trim()
        }
        out
    }

    /** Process environment first, then the private env file (like the TS twin: a variable set, even blank, wins). */
    fun env(name: String): String? = System.getenv(name) ?: fileEnv[name]

    private fun resolveRepoRoot(): File {
        System.getenv("RAIL_ROOT")?.let { return File(it) }
        var d: File? = File("").absoluteFile
        while (d != null) {
            if (File(d, "data/network.json.gz").exists()) return d
            d = d.parentFile
        }
        return File("..").absoluteFile
    }

    val root: File = resolveRepoRoot()
    val port = (env("PORT") ?: "8787").toInt()
    val host = env("HOST") ?: "127.0.0.1"
    val mqttUrl = env("MQTT_URL") ?: ""
    val mqttUsername: String? = env("MQTT_USERNAME")
    val mqttPassword: String? = env("MQTT_PASSWORD")
    val dataDir: File = env("RAIL_DATA_DIR")?.let { File(it) } ?: File(root, "data")
    val daysDir: File = env("RAIL_DAYS_DIR")?.let { File(it) } ?: (if (File(root, "data/days").exists()) File(root, "data/days") else File("/workspace/sbb/gtfs"))
    val gtfsRtKey = env("OTD_GTFS_RT_KEY") ?: ""
    val gtfsRtUrl = env("OTD_GTFS_RT_URL") ?: "https://api.opentransportdata.swiss/la/gtfs-rt"
    val rtIntervalMs = (env("RT_INTERVAL_MS") ?: "13000").toLong()
    val gtfsSaKey = env("OTD_GTFS_SA_KEY") ?: ""
    val gtfsSaUrl = env("OTD_GTFS_SA_URL") ?: "https://api.opentransportdata.swiss/la/gtfs-sa"
    val saIntervalMs = (env("SA_INTERVAL_MS") ?: "180000").toLong()
    val anthropicKey = env("ANTHROPIC_API_KEY") ?: ""
    val bulletinModel = env("BULLETIN_MODEL") ?: "claude-haiku-5-5"
    val bulletinTimeoutMs = (env("BULLETIN_TIMEOUT_MS") ?: "2000").toLong()
    val bulletinBackgroundMs = (env("BULLETIN_BACKGROUND_MS") ?: "8000").toLong()
    val topicRoot = env("TOPIC_ROOT") ?: "sbb-twin/v1"
    val production = env("NODE_ENV") == "production"
    val viewerDir: File = env("RAIL_VIEWER_DIR")?.let { File(it) } ?: File(root, "viewer")
    val stateFile: File = env("RAIL_STATE_FILE")?.let { File(it) } ?: File(dataDir, "state.json")
}
