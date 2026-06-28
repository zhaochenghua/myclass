plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun String.asBuildConfigString(): String =
    "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""

fun String.asBuildConfigBoolean(name: String): String {
    val normalized = trim().lowercase()
    require(normalized == "true" || normalized == "false") {
        "$name must be true or false"
    }
    return normalized
}

val myClassServerUrl = providers
    .gradleProperty("MYCLASS_SERVER_URL")
    .orElse("http://10.30.13.1/myclass")
    .get()

val disableWebRtcNetworkMonitor = providers
    .gradleProperty("MYCLASS_WEBRTC_DISABLE_NETWORK_MONITOR")
    .orElse("true")
    .get()
    .asBuildConfigBoolean("MYCLASS_WEBRTC_DISABLE_NETWORK_MONITOR")

android {
    namespace = "cn.edu.nb3.myclass"
    compileSdk = 35

    buildFeatures {
        buildConfig = true
    }

    defaultConfig {
        applicationId = "cn.edu.nb3.myclass"
        minSdk = 26
        targetSdk = 35
        versionCode = 2026062903
        versionName = "1.3.1-20260629"

        buildConfigField("String", "SERVER_BASE_URL", myClassServerUrl.asBuildConfigString())
        buildConfigField("int", "VIDEO_WIDTH", "1920")
        buildConfigField("int", "VIDEO_HEIGHT", "1440")
        buildConfigField("int", "VIDEO_FPS", "24")
        buildConfigField("boolean", "WEBRTC_DISABLE_NETWORK_MONITOR", disableWebRtcNetworkMonitor)
    }

    signingConfigs {
        create("release") {
            storeFile = rootProject.file("myclass.keystore")
            storePassword = providers.gradleProperty("MYCLASS_KEYSTORE_PASSWORD").get()
            keyAlias = providers.gradleProperty("MYCLASS_KEY_ALIAS").get()
            keyPassword = providers.gradleProperty("MYCLASS_KEY_PASSWORD").get()
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.github.webrtc-sdk:android:125.6422.07")
}
