//settings.gradle.kts

pluginManagement {
    val flutterSdkPath = run {
        val properties = java.util.Properties()
        file("local.properties").inputStream().use { properties.load(it) }
        val flutterSdkPath = properties.getProperty("flutter.sdk")
        require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
        flutterSdkPath
    }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}

include(":app")

// Fix for flutter_jailbreak_detection which uses `namespace project.group` but
// project.group may not be resolved when AGP reads namespace during configuration.
// Set group before any project is configured so the namespace resolves correctly.
gradle.beforeProject {
    if (project.name == "flutter_jailbreak_detection") {
        project.setProperty("group", "appmire.be.flutterjailbreakdetection")
    }
}
