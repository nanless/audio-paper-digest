import java.security.MessageDigest

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.plugin.compose") }
android {
    namespace = "com.nanless.paperdigest"
    compileSdk = 37
    ndkVersion = "27.2.12479018"
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    defaultConfig { applicationId = "com.nanless.paperdigest"; minSdk = 28; targetSdk = 37; versionCode = 3; versionName = "1.0.0"; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"; ndk { abiFilters += setOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64") }; externalNativeBuild { cmake { arguments += "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON" } } }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    testOptions { unitTests.isReturnDefaultValues = false }
    sourceSets.getByName("androidTest").assets.srcDir("src/test/resources")
    packaging { resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/LICENSE.md", "META-INF/LICENSE-notice.md") }
}
kotlin { jvmToolchain(17) }
// Full boundary fixtures deliberately retain multiple near-limit original JSON byte/string views.
// This is the host JVM test budget, not an Android heap/size-policy or assertion change.
tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach { maxHeapSize = "2g" }
dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.google.android.material:material:1.13.0")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("androidx.fragment:fragment-compose:1.8.9")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")
    implementation("androidx.compose.material3.adaptive:adaptive:1.3.0")
    implementation("androidx.compose.material3.adaptive:adaptive-layout:1.3.0")
    implementation("androidx.compose.material3.adaptive:adaptive-navigation:1.3.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jsoup:jsoup:1.21.2")
    implementation("org.commonmark:commonmark:0.24.0")
    implementation("org.commonmark:commonmark-ext-gfm-tables:0.24.0")
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    implementation("androidx.pdf:pdf-viewer-fragment:1.0.0-beta01")
    implementation("com.tom-roush:pdfbox-android:2.0.27.0")
    implementation("androidx.core:core-ktx:1.17.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

// Debug is the private scientific verification channel. Formal release has its
// own freshly generated empty bootstrap and never consumes the debug output.
val assetRepoRoot = rootProject.projectDir.parentFile.parentFile
for ((variantName, contentChannel) in mapOf("debug" to "private-qa", "release" to "release")) {
    val capitalized = variantName.replaceFirstChar { it.uppercaseChar() }
    val generatedAssets = layout.buildDirectory.dir("generated/published-assets/$variantName")
    val runtimeMaterialsFile = layout.buildDirectory.file("intermediates/paperdigest/runtime-materials-$variantName.json")
    val prepareVariantAssets = tasks.register<Exec>("prepare${capitalized}PublishedAssets") {
        workingDir(rootProject.projectDir)
        commandLine("node", rootProject.file("prepare-assets.mjs").absolutePath, "--channel", contentChannel,
            "--runtime-materials", runtimeMaterialsFile.get().asFile.absolutePath)
        inputs.file(rootProject.file("prepare-assets.mjs"))
        inputs.dir(rootProject.file("licenses"))
        inputs.dir(File(assetRepoRoot, "apps/macos/node_modules/katex/dist"))
        inputs.file(File(assetRepoRoot, "apps/macos/node_modules/katex/LICENSE"))
        if (contentChannel == "private-qa") {
            inputs.file(File(assetRepoRoot, "prototypes/macos-research/sample.json"))
            inputs.dir(File(assetRepoRoot, "prototypes/macos-research/assets"))
            inputs.file(File(assetRepoRoot, "prototypes/macos-research/vendor/marked.esm.js"))
        }
        outputs.dir(generatedAssets)
        outputs.upToDateWhen { false }
        doFirst {
            // Bind both content channels to the actual formal runtime graph.
            // This private build input has no cache paths and is not an asset.
            val artifacts = configurations.getByName("releaseRuntimeClasspath").resolvedConfiguration.resolvedArtifacts.map { artifact ->
                val module = artifact.moduleVersion.id
                val digest = MessageDigest.getInstance("SHA-256")
                artifact.file.inputStream().use { input ->
                    val buffer = ByteArray(65536)
                    while (true) { val count = input.read(buffer); if (count < 0) break; if (count > 0) digest.update(buffer, 0, count) }
                }
                mapOf("group" to module.group, "module" to module.name, "version" to module.version,
                    "classifier" to artifact.classifier, "type" to artifact.type, "extension" to artifact.extension,
                    "fileName" to artifact.file.name, "bytes" to artifact.file.length(),
                    "sha256" to digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) })
            }
            val output = runtimeMaterialsFile.get().asFile
            output.parentFile.mkdirs()
            output.writeText(groovy.json.JsonOutput.toJson(mapOf("contract" to "android-runtime-build-materials-v1", "artifacts" to artifacts)))
        }
    }
    android.sourceSets.getByName(variantName).assets.srcDir(generatedAssets.get().asFile)
    // Explicitly wire both normal builds and direct mergeAssets invocations.
    tasks.matching { it.name == "pre${capitalized}Build" || it.name == "merge${capitalized}Assets" }
        .configureEach { dependsOn(prepareVariantAssets) }
}
