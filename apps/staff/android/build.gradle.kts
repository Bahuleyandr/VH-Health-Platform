import com.android.build.api.dsl.LibraryExtension
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
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
