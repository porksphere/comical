// Gradle build for the Android host (coexists with the Bun monorepo, which ignores this).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "comical-android"

include(":host-android")
project(":host-android").projectDir = file("packages/host-android")
