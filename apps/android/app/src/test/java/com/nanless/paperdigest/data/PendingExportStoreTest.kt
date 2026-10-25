package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Candidate author tests; isolated synthetic files and readback, no Android/SAF claims. */
class PendingExportStoreTest {
    private class Death: Error("Synthetic process death")
    private class Fixture(val boundary:(String)->Unit={}) {
        val root=Files.createTempDirectory("pending-export-author-").toRealPath().toFile()
        val exports=File(root,"Exports");val controls=File(root,"Pending")
        val store=PendingExportStore(exports,controls,{"2026-01-01T00:00:00Z"},boundary)
        fun nextStore()=PendingExportStore(exports,controls,{"2026-01-01T00:00:01Z"})
        fun begin()=store.begin(UUID.randomUUID().toString(),"backup",JSONObject().put("paperID","synthetic").put("readingToken","a".repeat(64)))
        fun artifact(p:PendingExportStore.PendingExport,data:ByteArray="Synthetic exact original".toByteArray()):ByteArray {
            JsonFiles.write(File(exports,"${p.documentID}.bin"),data)
            JsonFiles.write(File(exports,"${p.documentID}.json"),JSONObject().put("documentID",p.documentID).put("mime","application/octet-stream")
                .put("suggestedName","Synthetic.paperdigest").put("bytes",data.size).put("sha256",BackupCodec.hash(data)))
            return data
        }
        fun snapshots()=root.walkTopDown().filter{it.isFile}.associate{it.relativeTo(root).invariantSeparatorsPath to BackupCodec.hash(it)}
        fun close(){root.deleteRecursively()}
    }
    @Test fun originalDocumentReadySurvivesRestartAndNeverRecaptures() {
        val f=Fixture()
        try {
            val p=f.begin();assertEquals("preparing",p.preparation);assertNull(p.artifact)
            val bytes=f.artifact(p);val ready=f.store.markReady(p.operationID)
            assertEquals("ready",ready.preparation);assertEquals("none",ready.delivery);assertArrayEquals(bytes,ready.artifact!!.file.readBytes())
            val restarted=f.nextStore().reconcile().single()
            assertEquals(p.operationID,restarted.operationID);assertEquals(p.documentID,restarted.documentID);assertEquals(ready.artifact!!.sha256,restarted.artifact!!.sha256)
            assertEquals(p.jobID,restarted.jobID);assertEquals(p.createdAt,restarted.createdAt)
        }finally{f.close()}
    }
    @Test fun candidateManifestAndReadyCrashWindowsContinueOnlySameReservedUuid() {
        for(point in listOf("candidate.persisted","manifest.persisted","ready.persisted")) {
            var died=false;val f=Fixture{if(it==point&&!died){died=true;throw Death()}}
            try {
                val p=f.begin();val bytes=f.artifact(p);assertTrue(runCatching{f.store.markReady(p.operationID)}.exceptionOrNull() is Death)
                val restarted=f.nextStore();val state=restarted.reconcile().single()
                if(point=="ready.persisted")assertEquals("ready",state.preparation)else assertEquals("interrupted",state.preparation)
                val ready=if(state.artifact!=null)state else restarted.markReady(p.operationID)
                assertEquals(p.documentID,ready.documentID);assertEquals(p.jobID,ready.jobID);assertEquals(p.createdAt,ready.createdAt)
                assertArrayEquals(bytes,ready.artifact!!.file.readBytes())
            }finally{f.close()}
        }
    }
    @Test fun lateChooserCallbackCannotTargetANewerSaveAttempt() {
        val f=Fixture()
        try {
            val p=f.begin();f.artifact(p);f.store.markReady(p.operationID)
            val first=f.store.beginDelivery(p.operationID);val cancelled=f.store.chooserCancelled(p.operationID,first.attemptID!!)
            assertNotNull(cancelled.artifact);assertEquals("ready",cancelled.preparation)
            val second=f.store.beginDelivery(p.operationID);assertNotEquals(first.attemptID,second.attemptID)
            val before=f.snapshots();assertTrue(runCatching{f.store.startWriting(p.operationID,first.attemptID!!)}.isFailure)
            assertEquals(before,f.snapshots());assertEquals(second.attemptID,f.store.get(p.operationID).attemptID)
        }finally{f.close()}
    }
    @Test fun writingIsNotVerificationAndFailedFullReadbackKeepsOriginalReady() {
        val f=Fixture()
        try {
            val p=f.begin();val bytes=f.artifact(p);f.store.markReady(p.operationID);val a=f.store.beginDelivery(p.operationID).attemptID!!
            assertArrayEquals(bytes,f.store.startWriting(p.operationID,a).file.readBytes())
            assertEquals("written-unverified",f.store.recordWritten(p.operationID,a).delivery)
            assertTrue(runCatching{f.store.verifyDelivery(p.operationID,a){error("Synthetic readback mismatch")}}.isFailure)
            assertEquals("written-unverified",f.nextStore().get(p.operationID).delivery)
            var verified=0
            val done=f.store.verifyDelivery(p.operationID,a){artifact->verified++;assertEquals(BackupCodec.hash(bytes),artifact.sha256);assertArrayEquals(bytes,artifact.file.readBytes())}
            assertEquals(1,verified);assertEquals("verified",done.delivery);assertEquals("ready",done.preparation)
            val originalAttempt=f.store.deliveryHistory(p.operationID).single().toString()
            val b=f.store.beginDelivery(p.operationID).attemptID!!;f.store.chooserCancelled(p.operationID,b)
            assertEquals(2,f.store.deliveryHistory(p.operationID).size)
            assertEquals(originalAttempt,f.store.deliveryHistory(p.operationID).single{it.getString("attemptID")==a}.toString())
        }finally{f.close()}
    }
    @Test fun mutatedOrMissingRawFilesNeverReturnReadyAndAreNotRecreated() {
        for(missing in listOf(false,true)) {
            val f=Fixture()
            try {
                val p=f.begin();f.artifact(p);f.store.markReady(p.operationID);val bin=File(f.exports,"${p.documentID}.bin")
                if(missing)assertTrue(bin.delete())else bin.appendText("changed")
                val bad=if(bin.exists())bin.readBytes()else null
                val unavailable=f.nextStore().get(p.operationID);assertEquals("unavailable",unavailable.preparation);assertNull(unavailable.artifact)
                assertFalse(unavailable.json().getBoolean("ready"));assertTrue(runCatching{f.store.beginDelivery(p.operationID)}.isFailure)
                if(bad==null)assertFalse(bin.exists())else assertArrayEquals(bad,bin.readBytes())
            }finally{f.close()}
        }
    }
    @Test fun mutableCapacityProofFieldsDoNotReplaceOriginalManifestOrGrantVerification() {
        val f=Fixture()
        try {
            val p=f.begin();f.artifact(p);val ready=f.store.markReady(p.operationID)
            val saved=File(f.controls,"${p.operationID}/manifest.original.json");val before=saved.readBytes()
            val current=File(f.exports,"${p.documentID}.json");val m=JSONObject(current.readText()).put("savedAt","2026-01-01T00:00:00Z")
                .put("savedSHA256",ready.artifact!!.sha256).put("savedBytes",ready.artifact!!.bytes).put("savedProofID",UUID.randomUUID().toString())
            JsonFiles.write(current,m)
            val same=f.nextStore().get(p.operationID);assertNotNull(same.artifact);assertEquals("none",same.delivery)
            assertEquals(ready.artifact!!.manifestSHA256,same.artifact!!.manifestSHA256);assertArrayEquals(before,saved.readBytes())
            JsonFiles.write(current,m.put("suggestedName","Different material name"));assertEquals("unavailable",f.store.get(p.operationID).preparation)
        }finally{f.close()}
    }
    @Test fun preparationCancellationOnlyRemovesItsOwnCaptureTempAndCannotDeleteReadyArtifact() {
        val f=Fixture()
        try {
            val p=f.begin();val temp=f.store.preparationFile(p.operationID);temp.writeText("Synthetic partial encoded backup")
            val unknown=File(temp.parentFile,"unrecognized-original").apply{writeText("preserve")};val bytes=f.artifact(p)
            f.store.cancelPreparation(p.operationID);assertFalse(temp.exists());assertEquals("preserve",unknown.readText())
            assertArrayEquals(bytes,File(f.exports,"${p.documentID}.bin").readBytes());assertTrue(runCatching{f.store.markReady(p.operationID)}.isFailure)
            val ready=f.begin();val original=f.artifact(ready);f.store.markReady(ready.operationID)
            assertTrue(runCatching{f.store.cancelPreparation(ready.operationID)}.isFailure)
            assertArrayEquals(original,File(f.exports,"${ready.documentID}.bin").readBytes())
        }finally{f.close()}
    }
    @Test fun interruptedSystemWritingCanRetryWithoutLosingPriorMaterialOrInventingSuccess() {
        val f=Fixture()
        try {
            val p=f.begin();val bytes=f.artifact(p);f.store.markReady(p.operationID);val a=f.store.beginDelivery(p.operationID).attemptID!!;f.store.startWriting(p.operationID,a)
            val restarted=f.nextStore();val state=restarted.reconcile().single()
            assertEquals("failed",state.delivery);assertNotNull(state.artifact);assertTrue(state.message!!.contains("部分文件"))
            assertNotEquals(a,restarted.beginDelivery(p.operationID).attemptID)
            assertArrayEquals(bytes,File(f.exports,"${p.documentID}.bin").readBytes())
        }finally{f.close()}
    }
    @Test fun invalidIdsAndSymlinksNeverReachForeignFilesOrDeleteThem() {
        val f=Fixture()
        try {
            val foreign=File(f.root,"foreign").apply{writeText("must preserve")};val original=foreign.readBytes()
            for(id in listOf("../foreign","not-a-uuid","0000-00-00",""))assertTrue(runCatching{f.store.get(id)}.isFailure)
            val p=f.begin();f.artifact(p);f.store.markReady(p.operationID);val bin=File(f.exports,"${p.documentID}.bin")
            assertTrue(bin.delete());Files.createSymbolicLink(bin.toPath(),foreign.toPath())
            assertEquals("unavailable",f.store.get(p.operationID).preparation);assertArrayEquals(original,foreign.readBytes())
            assertTrue(runCatching{PendingExportStore(File(f.root,"overlap"),File(f.root,"overlap/child"))}.isFailure)
        }finally{f.close()}
    }
    @Test fun cancellationAndPostReadCorruptionCannotPublishReadyOrVerified() {
        val f=Fixture()
        try {
            val p=f.begin();f.artifact(p)
            assertTrue(runCatching{f.store.markReady(p.operationID){throw CancellationException("Synthetic cancel")}}.exceptionOrNull() is CancellationException)
            assertEquals("preparing",f.store.get(p.operationID).preparation)
            f.store.markReady(p.operationID);val a=f.store.beginDelivery(p.operationID).attemptID!!;f.store.startWriting(p.operationID,a);f.store.recordWritten(p.operationID,a)
            assertTrue(runCatching{f.store.verifyDelivery(p.operationID,a){File(f.exports,"${p.documentID}.bin").appendText("changed after destination verification")}}.isFailure)
            assertEquals("unavailable",f.store.get(p.operationID).preparation)
            assertNotEquals("verified",f.store.get(p.operationID).delivery)
        }finally{f.close()}
    }
}
