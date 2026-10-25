pluginManagement { check(System.getenv("CODEX_SANDBOX").isNullOrEmpty()) { "Android 项目须在正常本机环境执行" }; repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = "PaperDigestAndroid"
include(":app")
