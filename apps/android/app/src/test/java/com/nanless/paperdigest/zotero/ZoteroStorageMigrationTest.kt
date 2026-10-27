package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.secret.SecretStore
import com.nanless.paperdigest.zotero.webdav.ZoteroDavTarget
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.UUID

class ZoteroStorageMigrationTest {
    private data class Fixture(val root: File, val research: File, val parentID: String, val target: ZoteroDavTarget)
    private fun fixture(): Fixture = runBlocking {
        val root = Files.createTempDirectory("pd-migration-qa").toFile().canonicalFile; val research = File(root, "Research").apply { mkdir() }
        val secret = object : SecretStore { override fun load(scope: String): String? = error("NO_CREDENTIAL_READ_ALLOWED"); override fun save(scope: String, secret: String) = error("NO_CREDENTIAL_WRITE_ALLOWED"); override fun remove(scope: String) = error("NO_CREDENTIAL_REMOVE_ALLOWED") }
        val network = object : ZoteroTransport { override suspend fun request(request: Request, limit: Int): HttpBytes = error("NO_NETWORK_ALLOWED"); override suspend fun download(request: Request, target: File, limit: Long): HttpFile = error("NO_NETWORK_ALLOWED") }
        val provider = ZoteroMaterialProvider { val files = listOf("source-metadata" to "application/json", "pdf" to "application/pdf", "guide" to "text/html", "analysis" to "application/json").map { (role, type) -> val f = File(root, role).apply { writeText("PUBLIC-SYNTHETIC-$role") }; ZoteroMaterial(role, "QA $role", type, f, sha256 = BackupCodec.hash(f)) }; val note = "<p>synthetic note</p>"; ZoteroMaterials("arxiv:2601.00001", "a".repeat(64), JSONObject().put("itemType", "preprint").put("title", "Frozen QA source"), files + ZoteroMaterial("note", "QA note", "text/html", noteHTML = note, sha256 = sha256(note.toByteArray()))) }
        val service = ZoteroService(research, secret, provider, network); service.execute("save", JSONObject().put("libraryType", "users").put("libraryID", "123")); val id = service.execute("prepare").getString("preparedID")
        val target = ZoteroDavTarget.native("users", "123", "https://dav.jianguoyun.com/dav/explicit-qa", "qa@example.invalid", UUID.randomUUID().toString(), UUID.randomUUID().toString()); Fixture(root, research, id, target)
    }
    private fun observations(parent: MigrationParent) = parent.header().getJSONArray("roles").objects().map { MigrationApiObservation(it.getString("key"), false, null, null, null, null, false) }
    @Test fun childKeepsParentBytesKeysAndMaterialsAndStartsDAVUnverified() {
        val f = fixture(); val store = ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles); val parent = store.captureParent(f.parentID); val before = File(f.research, "ZoteroArchives/${f.parentID}").listFiles()!!.associate { it.name to BackupCodec.hash(it) }; val child = store.create(parent, f.target, observations(parent)) {}
        assertNotEquals(parent.id, child.id); assertEquals(before, File(f.research, "ZoteroArchives/${f.parentID}").listFiles()!!.associate { it.name to BackupCodec.hash(it) }); assertEquals(parent.header().getString("parentKey"), child.journal.getString("parentKey")); assertEquals(parent.header().getJSONArray("roles").objects().map { it.getString("key") }, child.journal.getJSONArray("roles").objects().map { it.getString("key") }); assertTrue(child.journal.getJSONArray("roles").objects().all { it.getString("status") == "prepared" && !it.has("davJournalID") && !it.has("davVerification") }); assertEquals(child.id, store.childForParent(parent.id)); store.requireChild(child)
    }
    @Test fun sameSourceConfirmationReusesOnePublishedChild() { val f = fixture(); val store = ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles); val parent = store.captureParent(f.parentID); val a = store.create(parent, f.target, observations(parent)) {}; val b = store.create(parent, f.target, observations(parent)) {}; assertEquals(a.id, b.id); assertEquals(2, File(f.research, "ZoteroArchives").listFiles()!!.count { it.name.runCatching { UUID.fromString(this) }.isSuccess }) }
    @Test fun changedSourceOrMaterialNeverPublishesChild() { val f = fixture(); val store = ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles); val parent = store.captureParent(f.parentID); File(f.research, "ZoteroArchives/${parent.id}/material-0").appendText("changed"); assertThrows(Exception::class.java) { store.create(parent, f.target, observations(parent)) {} }; assertFalse(store.parentHasMigration(parent.id)) }
    @Test fun parentCASAndSourceCopyTamperingRejectExistingChild() { val f = fixture(); val store = ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles); val parent = store.captureParent(f.parentID); val child = store.create(parent, f.target, observations(parent)) {}; File(f.research, "ZoteroArchives/${parent.id}/journal.json").appendText(" "); assertThrows(Exception::class.java) { store.openChild(child.id) }; assertTrue(store.parentHasMigration(parent.id)) }
    @Test fun linkPublicationFailureRecoversSameCompleteChildWithoutReplacingParent() { val f = fixture(); var fail = true; val store = ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles) { if (fail) throw IOException("SYNTHETIC-LINK-FAILURE") }; val parent = store.captureParent(f.parentID); assertThrows(Exception::class.java) { store.create(parent, f.target, observations(parent)) {} }; assertTrue(store.parentHasMigration(parent.id)); val original = store.childForParent(parent.id)!!; fail = false; val recovered = store.create(parent, f.target, observations(parent)) {}; assertEquals(original, recovered.id); assertEquals(parent.sha256, store.captureParent(parent.id).sha256) }
    @Test fun linkedDifferentTargetAndInternalSymlinkCannotRetargetOrRead() { val f = fixture(); val store = ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles); val parent = store.captureParent(f.parentID); store.create(parent, f.target, observations(parent)) {}; val other = ZoteroDavTarget.native("users", "123", "https://dav.jianguoyun.com/dav/other-qa", "qa@example.invalid", UUID.randomUUID().toString(), UUID.randomUUID().toString()); assertThrows(Exception::class.java) { store.create(parent, other, observations(parent)) {} }; val material = File(f.research, "ZoteroArchives/${parent.id}/material-1"); val outside = File(f.root, "outside-qa").apply { writeText("PUBLIC-QA-OUTSIDE") }; assertTrue(material.delete()); Files.createSymbolicLink(material.toPath(), outside.toPath()); assertThrows(Exception::class.java) { store.captureParent(parent.id) }; assertEquals("PUBLIC-QA-OUTSIDE", outside.readText()) }
    @Test fun cancellationDuringCopyRemovesOnlyUnpublishedCopyAndKeepsParentBytes() {
        val f=fixture();val store=ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles);val parent=store.captureParent(f.parentID)
        val directory=File(f.research,"ZoteroArchives/${f.parentID}");val before=directory.listFiles()!!.associate{it.name to BackupCodec.hash(it)};var checks=0
        assertThrows(kotlinx.coroutines.CancellationException::class.java){store.create(parent,f.target,observations(parent)){if(++checks==4)throw kotlinx.coroutines.CancellationException("SYNTHETIC-COPY-CANCEL")}}
        assertTrue(checks>=4);assertEquals(before,directory.listFiles()!!.associate{it.name to BackupCodec.hash(it)})
        assertFalse(File(f.research,"ZoteroArchives").listFiles()!!.any{it.name.startsWith(".migration-")});assertFalse(store.parentHasMigration(parent.id))
    }
    @Test fun failureDuringCopyLeavesNoUnpublishedStagingAndDoesNotChangeOriginal() {
        val f=fixture();val store=ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles);val parent=store.captureParent(f.parentID)
        val directory=File(f.research,"ZoteroArchives/${f.parentID}");val before=directory.listFiles()!!.associate{it.name to BackupCodec.hash(it)};var checks=0
        assertThrows(IOException::class.java){store.create(parent,f.target,observations(parent)){if(++checks==4)throw IOException("SYNTHETIC-COPY-FAILURE")}}
        assertEquals(before,directory.listFiles()!!.associate{it.name to BackupCodec.hash(it)});assertFalse(File(f.research,"ZoteroArchives").listFiles()!!.any{it.name.startsWith(".migration-")})
    }
    @Test fun exchangedStagingFileIsNeverDeletedByFailureCleanup() {
        val f=fixture();val store=ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles);val parent=store.captureParent(f.parentID);var checks=0;var exchanged:File?=null
        assertThrows(IOException::class.java){store.create(parent,f.target,observations(parent)){
            if(++checks==4){val stage=File(f.research,"ZoteroArchives").listFiles()!!.single{it.name.startsWith(".migration-")};val file=File(stage,"material-0");assertTrue(file.delete());file.writeText("SYNTHETIC-FOREIGN-INODE");exchanged=file;throw IOException("SYNTHETIC-EXCHANGE-FAILURE")}
        }}
        assertNotNull(exchanged);assertEquals("SYNTHETIC-FOREIGN-INODE",exchanged!!.readText());assertEquals(parent.sha256,store.captureParent(parent.id).sha256);assertFalse(store.parentHasMigration(parent.id))
    }

    @Test fun originalPhysicalTimesAreUntouchedAndApiWireTimeIsOnlySeparateProvenance(){
        val f=fixture();val store=ZoteroStorageMigrationStore(f.research,ZoteroOwnedDownloadTestFiles);val parent=store.captureParent(f.parentID)
        val original=parent.materialFacts.map{it.file.lastModified() to BackupCodec.hash(it.file)}
        val observations=observations(parent).map{it.copy(exists=true,version=1,md5="b".repeat(32),mtime=1234567890000,apiDataSHA256="c".repeat(64),storageBytesVerified=true)}
        val child=store.create(parent,f.target,observations){}
        assertEquals(original,parent.materialFacts.map{it.file.lastModified() to BackupCodec.hash(it.file)})
        child.origin.getJSONArray("sourceMaterialTimes").objects().forEachIndexed{i,row->assertEquals(parent.materialFacts[i].mtime,row.getLong("sourceObservedMtimeMillis"));assertEquals(1234567890000,row.getLong("apiObservedWireMtimeMillis"));assertNotEquals(row.getLong("sourceObservedMtimeMillis"),row.getLong("apiObservedWireMtimeMillis"));assertTrue(row.getLong("copyInitialMtimeMillis")>0)}
        val reopened=store.openChild(child.id);assertEquals(child.origin.toString(),reopened.origin.toString());assertEquals(child.journal.getString("planSHA"),reopened.journal.getString("planSHA"))
    }

}
