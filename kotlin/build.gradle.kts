plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktor)
}

group = "ch.lauzhack.twin"
version = "1.0.0"

kotlin { jvmToolchain(21) }

application { mainClass.set("ch.lauzhack.twin.MainKt") }

repositories { mavenCentral() }

dependencies {
    implementation(libs.ktor.server.core)
    implementation(libs.ktor.server.netty)
    implementation(libs.ktor.server.websockets)
    implementation(libs.logback.classic)
    implementation(libs.paho.mqttv3)
    implementation(libs.jackson.databind)
    testImplementation(libs.kotlin.test.junit)
}

tasks.test { useJUnit() }
