package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.data.PersonalStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class FullWorkspaceMergeTest {
    @Test fun publishedPaperMetadataNeedsNoImportedPDFAndDoesNotReplaceLocalMetadata() {
        val temporary = Files.createTempDirectory("paperdigest-website-merge-").toRealPath().toFile()
        try {
            val sender = File(temporary, "sender").apply { mkdirs() }
            val receiver = File(temporary, "receiver").apply { mkdirs() }
            val id = "arxiv:2610.00001"
            fun paper(title: String) = JSONObject().put("id", id).put("title", title).put("sourceKind", "arxiv")
                .put("blogURL", "https://nanless.github.io/audio-paper-digest-blog/posts/website-paper/")
            val website = paper("Mac retained website entry").put("localRetained", true)
            val missingPdf = "f".repeat(64)
            val localId = "local:$missingPdf"
            val missingOriginal = JSONObject().put("id", localId).put("title", "Private PDF without bytes")
                .put("sourceKind", "local").put("pdfSHA", missingPdf).put("localPDFPath", "/tmp/foreign.pdf")
            val target = PersonalStore(receiver)
            target.replaceValidated(target.snapshot().put("personalPapers", JSONObject().put(id, paper("Android catalog entry"))))
            val source = PersonalStore.initial().put("personalPapers", JSONObject().put(id, website).put(localId, missingOriginal))
            PersonalStore(sender).replaceValidated(source)
            val archive = File(temporary, "original.paperdigest")
            BackupCodec.captureSelection(sender, archive, source, FullWorkspaceMerge::includes) {}
            val archiveDigest = BackupCodec.hash(archive)
            val staged = BackupCodec.stage(archive.inputStream(), temporary)
            assertEquals(1, FullWorkspaceMerge.merge(receiver, target, staged) {})
            val papers = target.snapshot().getJSONObject("personalPapers")
            assertEquals("Android catalog entry", papers.getJSONObject(id).getString("title"))
            assertFalse(papers.has(localId))
            assertEquals("Mac retained website entry", JSONObject(File(staged.directory, "personal.json").readText())
                .getJSONObject("personalPapers").getJSONObject(id).getString("title"))
            assertEquals(archiveDigest, BackupCodec.hash(archive))
        } finally { temporary.deleteRecursively() }
    }
}
