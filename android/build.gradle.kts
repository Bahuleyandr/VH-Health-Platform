// build.gradle.kts (Project level)

// Updated plugin versions to resolve the conflict.
plugins {
    // Updated to the version required by your environment
    id("com.android.application") version "8.10.1" apply false
    // Updated Kotlin version for compatibility
    id("org.jetbrains.kotlin.android") version "2.1.21" apply false
    // This line for the Google Services plugin is correct
    id("com.google.gms.google-services") version "4.4.2" apply false
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory = rootProject.layout.buildDirectory.dir("../../build").get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
