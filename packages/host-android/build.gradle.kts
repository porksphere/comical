plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.comical.host"
    compileSdk = 35

    defaultConfig {
        minSdk = 26          // QuickJS-Android requires API 26+
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // QuickJS Android binding (~1 MB vs V8's ~30 MB / Hermes' ~4 MB)
    implementation("io.github.dokar3:quickjs-android:0.1.1")

    // HTTP
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // JSON
    implementation("org.json:json:20240303")

    // Storage
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Testing
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("org.robolectric:robolectric:4.13")
}
