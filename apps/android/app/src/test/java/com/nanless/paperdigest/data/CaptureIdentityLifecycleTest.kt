package com.nanless.paperdigest.data
import com.nanless.paperdigest.cloud.BackupCodec
import org.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.lang.ref.WeakReference
import java.util.UUID
class CaptureIdentityLifecycleTest {
 private fun temp(body:(File)->Unit){val p=Files.createTempDirectory("capture-identity-life-").toRealPath().toFile();try{body(p)}finally{p.deleteRecursively()}}
 private fun research(p:File)=File(p,"Research").apply{mkdir();File(this,"personal.json").writeText(JSONObject().put("schema",1).put("notes",JSONObject()).put("settings",JSONObject()).put("favorites",JSONArray()).put("reading",JSONArray()).put("readingState",JSONObject()).put("annotations",JSONObject()).put("sessions",JSONArray()).put("jobs",JSONArray()).toString())}
 @Test fun structurallyEqualDataClassCopyCannotAcquireActualReturnIdentity()=temp{p->val root=research(p);val op=UUID.randomUUID().toString();val doc=UUID.randomUUID().toString();val dir=File(p,op).apply{mkdir()};val actual=BackupCodec.capture(root,File(dir,"capture.tmp"));val copied=actual.copy();assertEquals(actual,copied);assertFalse(actual===copied);val producer=ExportProducerReceipt(dir,op,doc,JSONObject().put("format","backup"));assertTrue(runCatching{producer.recordVerifiedCapture(copied,"application/octet-stream","synthetic.paperdigest")}.isFailure);assertFalse(producer.hasCompletionMaterials());assertFalse(File(dir,"producer-complete.json").exists());assertEquals(actual.sha256,producer.recordVerifiedCapture(actual,"application/octet-stream","synthetic.paperdigest").sha256);assertEquals(actual.sha256,ExportProducerReceipt(dir,op,doc,JSONObject().put("format","backup")).verifiedCapture().sha256)}
 private fun releasedCapture(root:File,file:File):WeakReference<BackupCodec.Captured>{val actual=BackupCodec.capture(root,file);BackupCodec.requireNormalCapture(actual);return WeakReference(actual)}
 @Test fun privateRegistryDoesNotRetainUnreferencedPeriodicCaptureAndPurgesExpiredIdentity()=temp{p->val root=research(p);val file=File(p,"orphan.paperdigest");val weak=releasedCapture(root,file);var attempts=0;while(weak.get()!=null&&attempts++<100){System.gc();Thread.sleep(10)};assertNull("The private registry must not retain periodic cloud DTO instances",weak.get());val dummy=BackupCodec.Captured(file,BackupCodec.hash(file),file.length(),1);assertTrue(runCatching{BackupCodec.requireNormalCapture(dummy)}.isFailure);val field=BackupCodec::class.java.getDeclaredField("completedCaptureIdentities").apply{isAccessible=true};val registry=field.get(null) as Set<*>;synchronized(registry){assertTrue("Expired weak identity entries must be purged on the next registry access",registry.none{(it as java.lang.ref.Reference<*>).get()==null})}}
}
