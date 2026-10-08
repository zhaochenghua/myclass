plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cn.edu.nb3.myclass.tv"
    compileSdk = 35
    defaultConfig {
        applicationId = "cn.edu.nb3.myclass.tv"
        minSdk = 21
        targetSdk = 35
        versionCode = 20261009
        versionName = "1.0.1"
        val endpoint = providers.gradleProperty("MYCLASS_TV_SERVER_URL")
            .orElse("https://sz.imst.xyz/myclass/").get()
        buildConfigField("String", "SERVER_BASE_URL", "\"${endpoint.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
        ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64") }
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        create("release") {
            storeFile = rootProject.file("myclass.keystore")
            storePassword = providers.gradleProperty("MYCLASS_KEYSTORE_PASSWORD").get()
            keyAlias = providers.gradleProperty("MYCLASS_KEY_ALIAS").get()
            keyPassword = providers.gradleProperty("MYCLASS_KEY_PASSWORD").get()
            enableV1Signing = true
            enableV2Signing = true
        }
    }
    buildTypes {
        debug { isCrunchPngs = false }
        release { signingConfig = signingConfigs.getByName("release") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.github.webrtc-sdk:android:125.6422.07")
}
