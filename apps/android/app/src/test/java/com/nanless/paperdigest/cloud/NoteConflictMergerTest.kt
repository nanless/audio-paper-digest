package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.data.AppFailure
import com.nanless.paperdigest.data.PersonalStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class NoteConflictMergerTest {
    private val ipadDevice = "00000000-0000-4000-8000-000000000000"
    private val macDevice = "00000000-0000-4000-8000-000000000001"
    private val androidDevice = "00000000-0000-4000-8000-000000000002"
    private val paperA = "arxiv:2601.00001"

    private fun localRoot(): JSONObject = PersonalStore.initial().put("favorites", JSONArray(listOf(paperA)))

    private fun putNote(root: JSONObject, paperId: String, text: String, revision: Int = 1) {
        root.getJSONObject("notes").put(paperId, JSONObject().put("text", text).put("revision", revision))
    }

    @Test
    fun syncPlanCapturesStructuredConflictWithoutAlteringWireProtocolFields() {
        val baseRoot = localRoot().also { putNote(it, paperA, "初始共识笔记", revision = 1) }
        val baseSync = PersonalWebDavSync.plan(baseRoot, macDevice, emptyMap())
        val sharedRemote = mapOf(macDevice to baseSync.upload!!)
        val androidPulled = PersonalWebDavSync.plan(PersonalStore.initial(), androidDevice, sharedRemote)

        putNote(baseSync.personal, paperA, "Mac 端推导：公式 (4) 收敛阶为 O(1/k)", revision = 2)
        putNote(androidPulled.personal, paperA, "Android 端实测：表 2 消融下降 1.8 dB", revision = 2)

        val macNext = PersonalWebDavSync.plan(baseSync.personal, macDevice, sharedRemote)
        val androidNext = PersonalWebDavSync.plan(androidPulled.personal, androidDevice, sharedRemote)
        val macUpload = macNext.upload!!
        val androidUpload = androidNext.upload!!

        // Verify wire document keys stay 100% compatible with 1.4.5 cross-platform protocol
        val wireJson = JSONObject(String(androidUpload, Charsets.UTF_8))
        assertEquals(
            setOf("format", "device", "revision", "records", PersonalWebDavSync.LEGACY_DIGEST),
            wireJson.keys().asSequence().toSet()
        )
        assertEquals(
            setOf("favorites", "reading", "notes", "annotations", "readingState"),
            wireJson.getJSONObject("records").keys().asSequence().toSet()
        )

        val remote = mapOf(macDevice to macUpload, androidDevice to androidUpload)
        val macPlan = PersonalWebDavSync.plan(macNext.personal, macDevice, remote)
        assertEquals(1, macPlan.conflicts)
        assertEquals(1, macPlan.noteConflicts.size)
        val item = macPlan.noteConflicts.single()
        assertEquals(paperA, item.paperId)
        assertEquals("Mac 端推导：公式 (4) 收敛阶为 O(1/k)", item.localNote)
        assertEquals("Android 端实测：表 2 消融下降 1.8 dB", item.remoteNote)
        assertEquals(androidDevice, item.remoteDeviceId)
        assertEquals(1L, item.remoteRevision)
        assertTrue(item.additionalRemotes.isEmpty())
        assertEquals(
            "Mac 端推导：公式 (4) 收敛阶为 O(1/k)",
            macPlan.personal.getJSONObject("notes").getJSONObject(paperA).getString("text")
        )
        PersonalStore.validate(macPlan.personal)
    }

    @Test
    fun emptyNoteClearConflictsAndThreeDeviceConcurrentNotesAreCapturedAndLosslesslyMerged() {
        // 1. Local cleared note ("") vs remote non-empty edit
        val seed = localRoot().also { putNote(it, paperA, "原笔记", revision = 1) }
        val seedSync = PersonalWebDavSync.plan(seed, macDevice, emptyMap())
        val baseRemote = mapOf(macDevice to seedSync.upload!!)
        val androidPulled = PersonalWebDavSync.plan(PersonalStore.initial(), androidDevice, baseRemote)

        putNote(seedSync.personal, paperA, "", revision = 2) // Mac cleared note to ""
        putNote(androidPulled.personal, paperA, "Android 补充的新实验记录", revision = 2)

        val macClearedSync = PersonalWebDavSync.plan(seedSync.personal, macDevice, baseRemote)
        val androidEditedSync = PersonalWebDavSync.plan(androidPulled.personal, androidDevice, baseRemote)
        val twoRemote = mapOf(macDevice to macClearedSync.upload!!, androidDevice to androidEditedSync.upload!!)

        val macView = PersonalWebDavSync.plan(macClearedSync.personal, macDevice, twoRemote)
        assertEquals(1, macView.conflicts)
        val emptyLocalConflict = macView.noteConflicts.single()
        assertEquals("", emptyLocalConflict.localNote)
        assertEquals("Android 补充的新实验记录", emptyLocalConflict.remoteNote)

        // Reverse perspective: Android (non-empty) sees Mac's cleared ("") remote note
        val androidView = PersonalWebDavSync.plan(androidEditedSync.personal, androidDevice, twoRemote)
        assertEquals(1, androidView.conflicts)
        val emptyRemoteConflict = androidView.noteConflicts.single()
        assertEquals("Android 补充的新实验记录", emptyRemoteConflict.localNote)
        assertEquals("", emptyRemoteConflict.remoteNote)

        // 2. Three-device concurrent heterogeneous notes (Mac, Android, iPad)
        val ipadPulled = PersonalWebDavSync.plan(PersonalStore.initial(), ipadDevice, baseRemote)
        putNote(ipadPulled.personal, paperA, "iPad 初版", revision = 2)
        val ipadStep1 = PersonalWebDavSync.plan(ipadPulled.personal, ipadDevice, baseRemote)
        // Edit paperA note again on iPad so iPad's note record has WebDAV revision = 2L > Android's 1L
        putNote(ipadStep1.personal, paperA, "iPad 端阅读批注汇总", revision = 3)
        val ipadStep2 = PersonalWebDavSync.plan(
            ipadStep1.personal,
            ipadDevice,
            baseRemote + (ipadDevice to ipadStep1.upload!!)
        )

        val threeDeviceRemote = mapOf(
            macDevice to macClearedSync.upload!!,
            androidDevice to androidEditedSync.upload!!,
            ipadDevice to ipadStep2.upload!!,
        )
        val threeWayMacPlan = PersonalWebDavSync.plan(macClearedSync.personal, macDevice, threeDeviceRemote)
        assertEquals(1, threeWayMacPlan.conflicts)
        val threeWayItem = threeWayMacPlan.noteConflicts.single()
        assertEquals("", threeWayItem.localNote)
        // Highest (revision, device) remote head is primary: ipadDevice has note revision=2L > androidDevice revision=1L
        assertEquals(ipadDevice, threeWayItem.remoteDeviceId)
        assertEquals(2L, threeWayItem.remoteRevision)
        assertEquals("iPad 端阅读批注汇总", threeWayItem.remoteNote)
        assertEquals(1, threeWayItem.additionalRemotes.size)
        assertEquals(androidDevice, threeWayItem.additionalRemotes.single().remoteDeviceId)
        assertEquals("Android 补充的新实验记录", threeWayItem.additionalRemotes.single().remoteNote)

        // 3. Uninitialized local note (JSONObject.NULL -> localNote = "", baseRevision = 0) observing concurrent remote heads
        val observerDevice = "00000000-0000-4000-8000-000000000004"
        val freshObserverPlan = PersonalWebDavSync.plan(
            PersonalStore.initial(),
            observerDevice,
            threeDeviceRemote
        )
        assertEquals(1, freshObserverPlan.conflicts)
        val nullLocalItem = freshObserverPlan.noteConflicts.single()
        assertEquals("", nullLocalItem.localNote)
        assertEquals(ipadDevice, nullLocalItem.remoteDeviceId)
        assertEquals(1, nullLocalItem.additionalRemotes.size)

        // ADOPT_REMOTE adopts primary (highest-revision remote head); MERGE_BOTH preserves ALL distinct remote heads
        assertEquals(
            "iPad 端阅读批注汇总",
            NoteConflictMerger.resolve(threeWayItem, NoteConflictStrategy.ADOPT_REMOTE)
        )
        val mergedThreeWay = NoteConflictMerger.resolve(threeWayItem, NoteConflictStrategy.MERGE_BOTH)
        assertTrue(mergedThreeWay.contains("iPad 端阅读批注汇总"))
        assertTrue(mergedThreeWay.contains("Android 补充的新实验记录"))
        assertTrue(mergedThreeWay.contains(NoteConflictMerger.remoteSectionHeader(ipadDevice, threeWayItem.remoteRevision)))
        assertTrue(mergedThreeWay.contains(NoteConflictMerger.remoteSectionHeader(androidDevice, 1L)))
        // Idempotent when re-applied
        assertEquals(
            mergedThreeWay,
            NoteConflictMerger.resolve(threeWayItem.copy(localNote = mergedThreeWay), NoteConflictStrategy.MERGE_BOTH)
        )

        // JSON round-trip preserves additionalRemotes
        assertEquals(threeWayItem, NoteConflictItem.fromJson(threeWayItem.json()))
    }

    @Test
    fun identicalConcurrentNotesProduceZeroConflictsAndEmptyConflictList() {
        val macRoot = localRoot().also { putNote(it, paperA, "完全一致的并发笔记正文", revision = 1) }
        val androidRoot = localRoot().also { putNote(it, paperA, "完全一致的并发笔记正文", revision = 5) }
        val macUpload = PersonalWebDavSync.plan(macRoot, macDevice, emptyMap()).upload!!
        val androidUpload = PersonalWebDavSync.plan(androidRoot, androidDevice, emptyMap()).upload!!

        val plan = PersonalWebDavSync.plan(androidRoot, androidDevice, mapOf(macDevice to macUpload, androidDevice to androidUpload))
        assertEquals(0, plan.conflicts)
        assertTrue(plan.noteConflicts.isEmpty())
    }

    @Test
    fun resolveSupportsKeepLocalAdoptRemoteAndLosslessIdempotentMergeBoth() {
        val conflict = NoteConflictItem(
            paperId = paperA,
            localNote = "第一段：本机推导 $\\alpha + \\beta = 1$\n- 观察 A",
            remoteNote = "第二段：云端实验补充 🙂\n- 观察 B",
            remoteDeviceId = macDevice,
            remoteRevision = 7L,
        )

        assertEquals(conflict.localNote, NoteConflictMerger.resolve(conflict, NoteConflictStrategy.KEEP_LOCAL))
        assertEquals(conflict.remoteNote, NoteConflictMerger.resolve(conflict, NoteConflictStrategy.ADOPT_REMOTE))

        val merged = NoteConflictMerger.resolve(conflict, NoteConflictStrategy.MERGE_BOTH)
        assertTrue(merged.contains(NoteConflictMerger.LOCAL_SECTION_HEADER))
        assertTrue(merged.contains(NoteConflictMerger.remoteSectionHeader(macDevice, 7L)))
        assertTrue(merged.contains(conflict.localNote))
        assertTrue(merged.contains(conflict.remoteNote))

        val reMerged = NoteConflictMerger.resolve(conflict.copy(localNote = merged), NoteConflictStrategy.MERGE_BOTH)
        assertEquals(merged, reMerged)

        val sameTextConflict = conflict.copy(remoteNote = conflict.localNote)
        assertEquals(conflict.localNote, NoteConflictMerger.resolve(sameTextConflict, NoteConflictStrategy.MERGE_BOTH))
    }

    @Test
    fun mergeBothRejectsExceedingSingleNoteTwoMiBUtf8LimitWithoutTruncation() {
        val chunk = "论".repeat(420_000) // 1,260,000 UTF-8 bytes (~1.20 MiB)
        assertTrue(chunk.toByteArray(Charsets.UTF_8).size < NoteConflictMerger.MAX_NOTE_BYTES)
        val conflict = NoteConflictItem(
            paperId = paperA,
            localNote = chunk + "_LOCAL",
            remoteNote = chunk + "_REMOTE",
            remoteDeviceId = macDevice,
            remoteRevision = 3L,
        )

        assertEquals(conflict.localNote, NoteConflictMerger.resolve(conflict, NoteConflictStrategy.KEEP_LOCAL))
        assertEquals(conflict.remoteNote, NoteConflictMerger.resolve(conflict, NoteConflictStrategy.ADOPT_REMOTE))

        val failure = assertThrows(AppFailure::class.java) {
            NoteConflictMerger.resolve(conflict, NoteConflictStrategy.MERGE_BOTH)
        }
        assertEquals("capacity", failure.category)
        assertTrue(failure.message.orEmpty().contains("2 MiB"))
    }

    @Test
    fun resolveAcceptsExactTwoMiBBoundaryAndRejectsTwoMiBPlusOneByte() {
        val exactTwoMiB = "a".repeat(NoteConflictMerger.MAX_NOTE_BYTES)
        val exactConflict = NoteConflictItem(
            paperId = paperA,
            localNote = exactTwoMiB,
            remoteNote = "short",
            remoteDeviceId = macDevice,
            remoteRevision = 2L,
        )
        assertEquals(exactTwoMiB, NoteConflictMerger.resolve(exactConflict, NoteConflictStrategy.KEEP_LOCAL))

        val overByOneByte = exactConflict.copy(localNote = exactTwoMiB + "b")
        val rejected = assertThrows(AppFailure::class.java) {
            NoteConflictMerger.resolve(overByOneByte, NoteConflictStrategy.KEEP_LOCAL)
        }
        assertEquals("capacity", rejected.category)
    }

    @Test
    fun resolveAccountsForFullJsonEntryWrapperAndRejectsIntMaxValueRevisionOverflow() {
        // Tight boundary where raw quoted string alone would fit, but JSON key + revision + 30B timestamp exceeds 32 MiB
        val noteText = "x".repeat(1024)
        val quotedOnlyBytes = JSONObject.quote(noteText).toByteArray(Charsets.UTF_8).size.toLong()
        val existingBytes = PersonalStore.MAX_BYTES - quotedOnlyBytes - 10L // Fits quoted text + 10B, but NOT full JSON entry wrapper (~90B overhead)
        val conflict = NoteConflictItem(paperA, noteText, "remote", macDevice, 2L)

        val wrapperRejected = assertThrows(AppFailure::class.java) {
            NoteConflictMerger.resolve(conflict, NoteConflictStrategy.KEEP_LOCAL, existingPersonalBytes = existingBytes)
        }
        assertEquals("capacity", wrapperRejected.category)

        // Snapshot with revision == Int.MAX_VALUE must reject before overflowing Int
        val maxRevSnapshot = PersonalStore.initial().also {
            it.getJSONObject("notes").put(paperA, JSONObject().put("text", noteText).put("revision", Int.MAX_VALUE))
        }
        assertThrows(IllegalArgumentException::class.java) {
            NoteConflictMerger.resolve(conflict, NoteConflictStrategy.KEEP_LOCAL, personalSnapshot = maxRevSnapshot)
        }

        // PersonalStore.saveNote also rejects baseRevision == Int.MAX_VALUE
        val dir = Files.createTempDirectory("pd-max-rev-test-").toRealPath().toFile()
        try {
            val store = PersonalStore(dir)
            assertThrows(IllegalArgumentException::class.java) {
                store.saveNote(paperA, "text", Int.MAX_VALUE)
            }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun conflictItemJsonRoundTripAndStrategyValidation() {
        val original = NoteConflictItem(paperA, "本机内容", "云端内容", macDevice, 12L)
        val decoded = NoteConflictItem.fromJson(original.json())
        assertEquals(original, decoded)
        // Legacy 5-field JSON without additionalRemotes also decodes cleanly
        val legacyJson = JSONObject()
            .put("paperId", paperA)
            .put("localNote", "本机")
            .put("remoteNote", "云端")
            .put("remoteDeviceId", macDevice)
            .put("remoteRevision", 3L)
        assertEquals(emptyList<RemoteNoteCandidate>(), NoteConflictItem.fromJson(legacyJson).additionalRemotes)

        assertEquals(NoteConflictStrategy.KEEP_LOCAL, NoteConflictStrategy.parse("keep-local"))
        assertEquals(NoteConflictStrategy.ADOPT_REMOTE, NoteConflictStrategy.parse("ADOPT_REMOTE"))
        assertEquals(NoteConflictStrategy.MERGE_BOTH, NoteConflictStrategy.parse("merge_both"))
        assertThrows(IllegalArgumentException::class.java) { NoteConflictStrategy.parse("drop_all") }
        assertThrows(IllegalArgumentException::class.java) { NoteConflictItem("", "a", "b", macDevice, 1L) }
        assertThrows(IllegalArgumentException::class.java) { NoteConflictItem(paperA, "a", "b", macDevice, 0L) }
    }
}
