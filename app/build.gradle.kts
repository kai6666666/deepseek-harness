plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.deepseek.harness"
    // compileSdk 35：AGP 8.7 的官方上限；36 需要 AGP 8.9+，CI 上先用 35 保稳
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.deepseek.harness"
        // minSdk 30: DSH web 是 Vite6 + React18 产物(ES2022),老 WebView 会白屏
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    // 可执行二进制以 .so 形式落到 lib/<abi>/,靠 nativeLibraryDir 拿到可执行位
    packaging {
        jniLibs { useLegacyPackaging = true }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { jvmToolchain(17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-service:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.webkit:webkit:1.12.1")
    // 本地回环 MCP 服务器（loopback only，不给外网）
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
