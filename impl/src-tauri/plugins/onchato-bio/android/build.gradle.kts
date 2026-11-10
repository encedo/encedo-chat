plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.encedo.onchato.bio"
    compileSdk = 36

    defaultConfig {
        // setUserAuthenticationParameters (a key that one strong biometric OR the
        // device credential unlocks, per use) is API 30; the app itself is 34.
        minSdk = 30
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation(project(":tauri-android"))
}
