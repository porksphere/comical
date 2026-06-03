plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.comical.host"
    compileSdk = 36 // required by quickjs-kt-android 1.0.5

    defaultConfig {
        minSdk = 26 // QuickJS-kt requires a recent NDK runtime; 26+ is safe
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        // Gradle-managed emulator: `./gradlew :host-android:pixel6Api35DebugAndroidTest` boots a
        // headless ATD emulator, runs the tests, and tears it down. Used for CI + hands-off runs;
        // `connectedDebugAndroidTest` still works against a manually-booted device for fast loops.
        managedDevices {
            localDevices {
                create("pixel6Api35") {
                    device = "Pixel 6"
                    apiLevel = 35
                    systemImageSource = "aosp-atd"
                }
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    // QuickJS binding (idiomatic Kotlin, coroutine/suspend API)
    implementation("io.github.dokar3:quickjs-kt-android:1.0.5")

    // HTTP + coroutines (org.json is provided by the Android platform — no dependency needed)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Instrumented tests (run on a device/emulator via connectedAndroidTest)
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
