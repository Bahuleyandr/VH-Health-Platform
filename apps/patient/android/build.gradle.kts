// build.gradle.kts (Project level)

import com.android.build.api.dsl.LibraryExtension
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

// Updated plugin versions to resolve the conflict.
plugins {
    // Updated to the version required by your environment
    id("com.android.application") version "8.10.1" apply false
    // Updated Kotlin version for compatibility
    id("org.jetbrains.kotlin.android") version "2.3.0" apply false
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

    // Flutter plugins declare different Java targets; keep each matching
    // Kotlin target instead of inheriting the Gradle daemon's newer JVM.
    plugins.withId("com.android.library") {
        val android = extensions.getByType<LibraryExtension>()
        tasks.withType<KotlinJvmCompile>().configureEach {
            compilerOptions.jvmTarget.set(
                provider {
                    JvmTarget.fromTarget(
                        android.compileOptions.targetCompatibility.toString(),
                    )
                },
            )
        }
    }
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
