package com.nanless.paperdigest

import com.nanless.paperdigest.data.AppFailure
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class RootResearchDirectoryTest {
    @Test fun nativeBaseAliasRemainsAllowedAndOnlyFixedChildIsCreated() {
        val root = Files.createTempDirectory("root-research-base-").toRealPath().toFile()
        try {
            val base = File(root, "Base").apply { mkdir() }; val alias = File(root, "NativeAlias")
            Files.createSymbolicLink(alias.toPath(), base.toPath())
            val result = RootResearchDirectory.resolve(alias)
            assertEquals(File(base, "PaperDigest"), result); assertTrue(result.isDirectory)
            assertEquals(listOf("PaperDigest"), base.list()!!.toList())
        } finally { root.deleteRecursively() }
    }
    @Test fun controlledResearchLinkIsRejectedBeforeAnyReadOrWrite() {
        val root = Files.createTempDirectory("root-research-link-").toRealPath().toFile()
        try {
            val base = File(root, "Base").apply { mkdir() }; val outside = File(root, "OwnedOutside").apply { mkdir() }
            val sentinel = File(outside, "original.bin").apply { writeBytes(byteArrayOf(0, 1, -1, 6)) }
            Files.createSymbolicLink(File(base, "PaperDigest").toPath(), outside.toPath())
            val failed = runCatching { RootResearchDirectory.resolve(base) }.exceptionOrNull()
            assertTrue(failed is AppFailure); assertEquals("storage", (failed as AppFailure).category)
            assertArrayEquals(byteArrayOf(0, 1, -1, 6), sentinel.readBytes())
            assertEquals(listOf("original.bin"), outside.list()!!.toList())
        } finally { root.deleteRecursively() }
    }
    @Test fun brokenChildLinkIsNotTreatedAsMissingDirectory() {
        val root = Files.createTempDirectory("root-research-broken-").toRealPath().toFile()
        try {
            val child = File(root, "PaperDigest"); val absent = File(root, "Absent")
            Files.createSymbolicLink(child.toPath(), absent.toPath())
            assertTrue(runCatching { RootResearchDirectory.resolve(root) }.isFailure)
            assertTrue(Files.isSymbolicLink(child.toPath())); assertFalse(absent.exists())
        } finally { root.deleteRecursively() }
    }
    @Test fun existingRegularFileAtChildIsRejectedUnchanged() {
        val root = Files.createTempDirectory("root-research-file-").toRealPath().toFile()
        try {
            val child = File(root, "PaperDigest").apply { writeBytes(byteArrayOf(8, 5, 3)) }
            assertTrue(runCatching { RootResearchDirectory.resolve(root) }.isFailure)
            assertArrayEquals(byteArrayOf(8, 5, 3), child.readBytes())
        } finally { root.deleteRecursively() }
    }
    @Test fun existingNormalResearchDirectoryAndEveryOriginalByteArePreserved() {
        val root = Files.createTempDirectory("root-research-existing-").toRealPath().toFile()
        try {
            val child = File(root, "PaperDigest").apply { mkdir() }; val sentinel = File(child, "personal.json").apply { writeText("original private synthetic bytes") }
            val before = sentinel.readBytes()
            assertEquals(child, RootResearchDirectory.resolve(root))
            assertArrayEquals(before, sentinel.readBytes()); assertEquals(listOf("personal.json"), child.list()!!.toList())
        } finally { root.deleteRecursively() }
    }
    @Test fun controlledCapacityAncestorLinkIsNotErasedBeforeActualStorageGuard() {
        val root = Files.createTempDirectory("root-capacity-child-link-").toRealPath().toFile()
        try {
            val base = File(root, "NoBackup").apply { mkdir() }; val research = File(base, "PaperDigest").apply { mkdir() }
            val outside = File(root, "OwnedOutside").apply { mkdir() }; val exports = File(outside, "Exports").apply { mkdir() }
            val sentinel = File(exports, "sentinel").apply { writeText("original outside bytes") }; val before = sentinel.readBytes()
            Files.createSymbolicLink(File(base, "PaperDigestTransfers").toPath(), outside.toPath())
            val paths = RootResearchDirectory.capacityPaths(base)
            val result = runCatching { com.nanless.paperdigest.data.StorageCapacity(research, paths.first, paths.second, paths.third).summary() }
            assertTrue("Actual StorageCapacity must see and reject its controlled ancestor link", result.isFailure)
            assertArrayEquals(before, sentinel.readBytes()); assertEquals(listOf("sentinel"), exports.list()!!.toList())
        } finally { root.deleteRecursively() }
    }
    @Test fun legitimateNativeBaseAliasRemainsAcceptedForCapacityMeasurement() {
        val root = Files.createTempDirectory("root-capacity-native-alias-").toRealPath().toFile()
        try {
            val base = File(root, "NoBackup").apply { mkdir() }; val alias = File(root, "NativeAlias")
            Files.createSymbolicLink(alias.toPath(), base.toPath())
            val research = RootResearchDirectory.resolve(alias)
            val paths = RootResearchDirectory.capacityPaths(alias)
            File(paths.first, "synthetic-export.bin").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(1, 2, 3, 4)) }
            val summary = com.nanless.paperdigest.data.StorageCapacity(research, paths.first, paths.second, paths.third).summary()
            val rows = summary.getJSONArray("rows")
            val exports = (0 until rows.length()).map { rows.getJSONObject(it) }.single { it.getString("id") == "exports" }
            assertEquals(4L, exports.getLong("bytes")); assertEquals(1L, exports.getLong("fileCount"))
        } finally { root.deleteRecursively() }
    }

}
