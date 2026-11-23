plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.example.sshcode.quest"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.example.sshcode.quest"
        minSdk = 34
        targetSdk = 34 // Quest Horizon OS is Android 14.
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += "arm64-v8a" }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
    packaging { resources.excludes += "META-INF/LICENSE*" }
}
dependencies {
    implementation("com.meta.spatial:meta-spatial-sdk:0.14.0")
    implementation("com.meta.spatial:meta-spatial-sdk-toolkit:0.14.0")
    implementation("com.meta.spatial:meta-spatial-sdk-vr:0.14.0")
    implementation("com.meta.spatial:meta-spatial-sdk-isdk:0.14.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.google.zxing:core:3.5.4")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}

val generateMascots by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir)
    commandLine("node", "scripts/generate-mascots.mjs")
    inputs.file(rootProject.file("scripts/generate-mascots.mjs"))
    inputs.file(rootProject.file("../../packages/shared/src/harnessMascotAnimations.ts"))
    inputs.dir(rootProject.file("../web/public/mascots"))
    outputs.dir(layout.buildDirectory.dir("generated/mascots/assets"))
}
android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/mascots/assets"))
tasks.named("preBuild").configure { dependsOn(generateMascots) }
