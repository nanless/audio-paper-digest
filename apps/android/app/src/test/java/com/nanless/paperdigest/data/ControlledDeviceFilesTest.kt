package com.nanless.paperdigest.data

import com.nanless.paperdigest.RootResearchDirectory
import com.nanless.paperdigest.cloud.*
import com.nanless.paperdigest.secret.SecretStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class ControlledDeviceFilesTest {
    private fun temporary(body: (File) -> Unit) {
        val root = Files.createTempDirectory("controlled-device-guard-").toRealPath().toFile()
        try { body(root) } finally { root.deleteRecursively() }
    }
    @Test fun modelClearCannotDeleteOutsideBindingThroughControlledDirectoryLink() = temporary { root ->
        val base = File(root, "Base").apply { mkdir() }; val outside = File(root, "Outside").apply { mkdir() }
        val file = File(outside, "model-key-binding.json").apply { writeText("outside original bytes") }; val original = file.readBytes()
        val alias = File(base, "PaperDigestDevice"); Files.createSymbolicLink(alias.toPath(), outside.toPath())
        assertTrue(runCatching { ModelKeyBinding(alias).clear() }.isFailure)
        assertArrayEquals(original, file.readBytes())
    }
    @Test fun dispatchConstructorCannotCreateOutsideCapabilityThroughControlledDirectoryLink() = temporary { root ->
        val base = File(root, "Base").apply { mkdir() }; val outside = File(root, "Outside").apply { mkdir() }
        val alias = File(base, "PaperDigestDevice"); Files.createSymbolicLink(alias.toPath(), outside.toPath())
        assertTrue(runCatching { WorkspaceDispatch(alias) }.isFailure)
        assertTrue(outside.listFiles()!!.isEmpty())
    }
    @Test fun modelBindClearAndReadRecheckFileLinkAfterConstruction() {
        for (action in listOf<(ModelKeyBinding) -> Unit>({ it.bind("https://synthetic.invalid/v1") }, { it.clear() }, { it.requireEndpoint("https://synthetic.invalid/v1") })) temporary { root ->
            val directory = File(root, "Device"); val binding = ModelKeyBinding(directory)
            val outside = File(root, "outside.json").apply { writeText("outside original bytes") }; val original = outside.readBytes()
            Files.createSymbolicLink(File(directory, "model-key-binding.json").toPath(), outside.toPath())
            assertTrue(runCatching { action(binding) }.isFailure); assertArrayEquals(original, outside.readBytes())
        }
    }
    @Test fun dispatchReadAndRotateRejectLaterRecordLinkWithoutChangingMemoryEpoch() = temporary { root ->
        val directory = File(root, "Device"); val dispatch = WorkspaceDispatch(directory); val epoch = dispatch.epoch
        val file = File(directory, "dispatch.json"); val outside = File(root, "outside.json").apply { writeBytes(file.readBytes()) }; val original = outside.readBytes()
        assertTrue(file.delete()); Files.createSymbolicLink(file.toPath(), outside.toPath())
        assertTrue(runCatching { WorkspaceDispatch(directory) }.isFailure)
        assertTrue(runCatching { dispatch.rotate() }.isFailure)
        dispatch.requireCurrent(epoch) // Does no file I/O and grants no external path access.
        assertArrayEquals(original, outside.readBytes()); assertEquals(epoch, dispatch.epoch)
    }
    @Test fun normalExistingBindingAndDispatchMigrateWithoutRewritingTheirBytes() = temporary { root ->
        val directory = File(root, "Device").apply { mkdir() }
        val bindingFile = File(directory, "model-key-binding.json").apply { writeText(JSONObject().put("contract", "paperdigest-model-key-binding-v1").put("endpoint", "https://synthetic.invalid/v1").toString()) }
        val epoch = UUID.randomUUID().toString()
        val dispatchFile = File(directory, "dispatch.json").apply { writeText(JSONObject().put("contract", "paperdigest-device-dispatch-v1").put("epoch", epoch).toString()) }
        val beforeBinding = bindingFile.readBytes(); val beforeDispatch = dispatchFile.readBytes()
        val binding = ModelKeyBinding(directory); binding.requireEndpoint(" https://synthetic.invalid/v1/ ")
        val dispatch = WorkspaceDispatch(directory); dispatch.requireCurrent(epoch)
        assertArrayEquals(beforeBinding, bindingFile.readBytes()); assertArrayEquals(beforeDispatch, dispatchFile.readBytes())
        dispatch.rotate(); assertNotEquals(epoch, dispatch.epoch); dispatch.requireCurrent(dispatch.epoch)
        assertTrue(runCatching { dispatch.requireCurrent(epoch) }.isFailure)
        binding.clear(); assertFalse(bindingFile.exists())
        binding.bind(" https://synthetic.invalid/new/ "); binding.requireEndpoint("https://synthetic.invalid/new")
    }
    @Test fun ordinaryDirectoryReplacementCannotRedirectLaterClearOrRotate() = temporary { root ->
        val directory = File(root, "Device"); val binding = ModelKeyBinding(directory); val dispatch = WorkspaceDispatch(directory)
        val old = File(root, "KeptDevice"); assertTrue(directory.renameTo(old)); assertTrue(directory.mkdir())
        val unknown = File(directory, "model-key-binding.json").apply { writeText("unknown replacement bytes") }; val before = unknown.readBytes()
        assertTrue(runCatching { binding.clear() }.isFailure); assertTrue(runCatching { dispatch.rotate() }.isFailure)
        assertArrayEquals(before, unknown.readBytes()); assertTrue(File(old, "dispatch.json").isFile)
    }
    @Test fun nativeBaseAliasIsNormalizedOnlyBeforeFixedDeviceChild() = temporary { root ->
        val base = File(root, "Base").apply { mkdir() }; val alias = File(root, "NativeAlias")
        Files.createSymbolicLink(alias.toPath(), base.toPath())
        val device = RootResearchDirectory.capacityPaths(alias).third
        ModelKeyBinding(device).bind("https://synthetic.invalid/v1")
        val dispatch = WorkspaceDispatch(device); dispatch.requireCurrent(dispatch.epoch)
        assertTrue(File(base, "PaperDigestDevice/dispatch.json").isFile)
    }
    @Test fun fixedCloudChildLinkIsRejectedButNormalSavedProfileLoadsWithZeroVaultOrNetwork() = temporary { root ->
        val base = File(root, "Base").apply { mkdir() }; val research = File(base, "PaperDigest").apply { mkdir() }
        val outside = File(root, "Outside").apply { mkdir() }
        val profile = File(outside, "profile.json").apply { writeText(JSONObject().put("contract", "paperdigest-android-cloud-profile-v1").put("destinationID", UUID.randomUUID().toString()).put("account", "synthetic-account").put("folder", "PaperDigest").put("automatic", false).put("intervalHours", 24).put("automaticPaused", false).toString()) }
        val before = profile.readBytes(); var vaultCalls = 0; var requests = 0
        val vault = object : SecretStore {
            override fun load(scope: String): String? { vaultCalls++; error("No credential operation") }
            override fun save(scope: String, secret: String) { vaultCalls++; error("No credential operation") }
            override fun remove(scope: String) { vaultCalls++; error("No credential operation") }
        }
        val workspace = object : CloudWorkspace {
            override suspend fun capture(output: File): BackupCodec.Captured = error("No capture")
            override suspend fun restore(staged: BackupCodec.Staged) = error("No restore")
        }
        val cloud = File(base, "PaperDigestCloud"); Files.createSymbolicLink(cloud.toPath(), outside.toPath())
        val failed = runCatching { CloudService(research, File(base.canonicalFile, "PaperDigestCloud"), vault, workspace, CloudTransport { _, _ -> requests++; error("No network") }).state() }
        assertTrue(failed.isFailure); assertArrayEquals(before, profile.readBytes())
        Files.delete(cloud.toPath()); assertTrue(cloud.mkdir()); File(cloud, "profile.json").writeBytes(before)
        val state = CloudService(research, File(base.canonicalFile, "PaperDigestCloud"), vault, workspace, CloudTransport { _, _ -> requests++; error("No network") }).state()
        assertEquals("synthetic-account", state.getString("account")); assertEquals(0, vaultCalls); assertEquals(0, requests)
        assertArrayEquals(before, profile.readBytes())
    }
}
