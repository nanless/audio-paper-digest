plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.plugin.compose") }
android {
    namespace = "com.nanless.paperdigest"
    compileSdk = 37
    defaultConfig { applicationId = "com.nanless.paperdigest"; minSdk = 28; targetSdk = 37; versionCode = 1; versionName = "1.0.0"; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner" }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    testOptions { unitTests.isReturnDefaultValues = false }
    sourceSets.getByName("androidTest").assets.srcDir("src/test/resources")
    packaging { resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/LICENSE.md", "META-INF/LICENSE-notice.md") }
}
kotlin { jvmToolchain(17) }
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

val preparePublishedAssets by tasks.registering(Exec::class) {
    val repoRoot = rootProject.projectDir.parentFile.parentFile
    workingDir(rootProject.projectDir)
    commandLine("node", rootProject.file("prepare-assets.mjs").absolutePath)
    inputs.file(rootProject.file("prepare-assets.mjs"))
    inputs.file(File(repoRoot, "prototypes/macos-research/sample.json"))
    outputs.dir(layout.buildDirectory.dir("generated/published-assets"))
    outputs.upToDateWhen { false }
    doLast {
        val source = File(repoRoot, "apps/macos/node_modules/katex/dist/katex.min.js")
        check(source.isFile) { "缺少锁定依赖的本地 KaTeX，请先安装 Mac 工作区已锁依赖" }
        copy {
            from(source)
            from(File(source.parentFile, "katex.min.css"))
            from(File(source.parentFile.parentFile, "LICENSE"))
            into(layout.buildDirectory.dir("generated/published-assets/katex"))
        }
        copy { from(File(source.parentFile,"fonts")); into(layout.buildDirectory.dir("generated/published-assets/katex/fonts")) }
    }
}
android.sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/published-assets").get().asFile)
tasks.named("preBuild").configure { dependsOn(preparePublishedAssets) }
