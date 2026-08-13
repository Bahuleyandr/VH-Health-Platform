import org.gradle.api.GradleException
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
val hasReleaseSigningConfig = keystorePropertiesFile.exists()
if (hasReleaseSigningConfig) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}

android {
    namespace = "com.vhhealth.staff.vhhealth_staff"
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // flutter_local_notifications (Code Blue full-screen intent) uses
        // Java 8 time APIs — desugaring backports them to pre-API-26 devices.
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        applicationId = "com.vhhealth.staff.vhhealth_staff"
        // Code Blue push + MAR scanner + workmanager need at least API 23 for
        // runtime permissions. Explicit minSdk keeps us off ancient devices.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        multiDexEnabled = true
    }

    signingConfigs {
        if (hasReleaseSigningConfig) {
            create("release") {
                val storeFilePath = keystoreProperties["storeFile"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storePassword = keystoreProperties["storePassword"] as String
                storeFile = rootProject.file(storeFilePath)
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseSigningConfig) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

gradle.taskGraph.whenReady {
    val releaseTasks = setOf("assembleRelease", "bundleRelease", "packageRelease")
    val requiresReleaseSigning = allTasks.any { task -> task.name in releaseTasks }
    if (requiresReleaseSigning && !hasReleaseSigningConfig) {
        throw GradleException("Release signing requires apps/staff/android/key.properties and a release keystore.")
    }
}

flutter {
    source = "../.."
}

dependencies {
    // Required by `isCoreLibraryDesugaringEnabled`. The version is pinned by
    // flutter_local_notifications' README — bump together with that plugin.
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}
