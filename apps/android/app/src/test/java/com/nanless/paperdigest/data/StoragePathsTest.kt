package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class StoragePathsTest {
    private fun root() = Files.createTempDirectory("research-paths-").toRealPath().toFile()
    @Test fun macAbsolutePathResolvesToSameOriginalBytesInsideAndroidRootOnly() {
        val root = root(); val file = File(root, "Imports/original.pdf"); val bytes = "%PDF-synthetic-fixture".toByteArray(); JsonFiles.write(file, bytes)
        JsonFiles.write(File(root, "RestoredPathRoots.json"), JSONObject().put("contract", "paperdigest-storage-aliases-v1").put("roots", JSONArray(listOf("/Users/fixture/Library/PaperDigest"))))
        assertEquals(file, StoragePaths.resolve("/Users/fixture/Library/PaperDigest/Imports/original.pdf", root, sha256(bytes)))
        assertArrayEquals(bytes, file.readBytes())
        assertThrows(IllegalArgumentException::class.java) { StoragePaths.resolve("/Users/other/Imports/original.pdf", root, sha256(bytes)) }
        assertThrows(IllegalArgumentException::class.java) { StoragePaths.resolve("/Users/fixture/Library/PaperDigest/Imports/original.pdf", root, "0".repeat(64)) }
    }
    @Test fun oldPathCannotTraverseOrFollowAnInsertedResearchSymlink() {
        val root = root(); val external = root(); val bytes = "not a research file".toByteArray(); val other = File(external, "source"); JsonFiles.write(other, bytes)
        Files.createSymbolicLink(File(root, "source").toPath(), other.toPath())
        assertThrows(IllegalArgumentException::class.java) { StoragePaths.resolve(File(root, "source").absolutePath, root, sha256(bytes)) }
        assertThrows(IllegalArgumentException::class.java) { StoragePaths.resolve(root.absolutePath + "/../source", root, sha256(bytes)) }
    }
    @Test fun restoredPreparedHistoryDoesNotAcquireDeviceDispatchCapability() {
        val device = root(); val research = root(); val dispatch = WorkspaceDispatch(device); val original = dispatch.epoch
        val store = PersonalStore(research); store.appendSession(JSONObject().put("id", "original").put("status", "prepared").put("requestIssued", false))
        store.upsertJob(JSONObject().put("id", "original").put("status", "queued")); dispatch.rotate(); store.retireRestoredDispatch()
        assertThrows(IllegalArgumentException::class.java) { dispatch.requireCurrent(original) }
        dispatch.requireCurrent(dispatch.epoch)
        assertEquals("interrupted", store.session("original")!!.getString("status")); assertFalse(store.session("original")!!.getBoolean("requestIssued"))
        assertEquals("not-issued", store.session("original")!!.getString("charge"))
        assertFalse(File(research, "dispatch.json").exists())
    }
}
