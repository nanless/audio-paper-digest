package com.nanless.paperdigest.model

import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.cloud.RequestContinuity
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class IssuedFloorPrepareTest {
 private fun store()=PersonalStore(Files.createTempDirectory("synthetic-floor-prepare-").toRealPath().toFile()).also { it.updateSettings(JSONObject().put("endpoint","https://synthetic.invalid/v1").put("model","synthetic-model").put("protocol","chat").put("dailyRequests",20)) }
 private fun source()=JSONObject().put("paperID","local:synthetic").put("kind","range").put("pages",JSONArray(listOf(1))).put("pdfSHA","a".repeat(64))
 private fun answer()=JSONObject().put("model","synthetic-model").put("choices",JSONArray().put(JSONObject().put("finish_reason","stop").put("message",JSONObject().put("content","synthetic answer")))).toString().toByteArray()
 private fun sealFloor(s:PersonalStore,id:String):ByteArray { val f=File(s.directory,RequestContinuity.FILE);JsonFiles.write(f,RequestContinuity.json(listOf(RequestContinuity.Issued(id,"2020-01-01T00:00:00Z"))));return f.readBytes() }
 private fun inputFiles(s:PersonalStore)=File(s.directory,"ModelUsage").listFiles()!!.filter{it.name.endsWith("-input.json")}.map{it.name}.toSet()
 private fun observe(name:String,value:JSONObject){val output=System.getProperty("floor.qa.output")?:return;File(output,name+".json").writeText(value.toString(2))}
 @Test fun sameFingerprintWithOnlyIssuedFloorCannotCreateOrDispatchAnotherSession()=runBlocking {
  val s=store();var calls=0;val service=StudyService(s,{"synthetic-key"}){_,_,_,_->calls++;HttpBytes(200,emptyMap(),answer())}
  val first=service.prepare("local:synthetic","question","material",source());val old=first.getString("id");val ledger=sealFloor(s,old);val personal=File(s.directory,"personal.json").readBytes();val inputs=inputFiles(s)
  var next:String?=null;var rejected=false
  try {next=service.prepare("local:synthetic","question","material",source()).getString("id");service.run(next)}catch(_:Exception){rejected=true}
  val proof=JSONObject().put("syntheticOnly",true).put("newSessionCreated",next!=null&&next!=old).put("fakeTransportCalls",calls).put("preparedSessionIssuedFlag",s.session(old)!!.getBoolean("requestIssued")).put("oldFloorStillPresent",RequestContinuity.read(s.directory).any{it.id==old}).put("ledgerBytesUnchanged",ledger.contentEquals(File(s.directory,RequestContinuity.FILE).readBytes())).put("personalBytesUnchanged",personal.contentEquals(File(s.directory,"personal.json").readBytes())).put("inputSetUnchanged",inputs==inputFiles(s)).put("rejected",rejected)
  observe("same-fingerprint-floor-only",proof)
  assertTrue("No automatic new session/input/transport or floor rewrite is allowed: $proof",calls==0&&inputs==inputFiles(s)&&ledger.contentEquals(File(s.directory,RequestContinuity.FILE).readBytes())&&personal.contentEquals(File(s.directory,"personal.json").readBytes()))
 }
 @Test fun runningOldIdWithConflictingFloorDoesNotProveNetworkReissue()=runBlocking {
  val s=store();var calls=0;val service=StudyService(s,{"synthetic-key"}){_,_,_,_->calls++;HttpBytes(200,emptyMap(),answer())};val id=service.prepare("local:synthetic","question","material",source()).getString("id");val ledger=sealFloor(s,id)
  assertTrue(runCatching{service.run(id)}.isFailure);assertEquals(0,calls);assertArrayEquals(ledger,File(s.directory,RequestContinuity.FILE).readBytes());assertFalse(s.session(id)!!.getBoolean("requestIssued"))
  observe("old-id-conflicting-floor",JSONObject().put("fakeTransportCalls",calls).put("ledgerUnchanged",true).put("notEvidenceOfOldIdReissue",true))
 }
 @Test fun explicitForceCanCreateNewStudyWhileRetainingOldFloor()=runBlocking {
  val s=store();var calls=0;val service=StudyService(s,{"synthetic-key"}){_,_,_,_->calls++;HttpBytes(200,emptyMap(),answer())};val old=service.prepare("local:synthetic","question","material",source()).getString("id");sealFloor(s,old)
  val next=service.prepare("local:synthetic","question","material",source(),force=true).getString("id");assertNotEquals(old,next);service.run(next);assertEquals(1,calls);assertEquals(setOf(old,next),RequestContinuity.read(s.directory).map{it.id}.toSet())
 }
 @Test fun unissuedPreparedWithoutFloorKeepsOriginalBehavior()=runBlocking {
  val s=store();var calls=0;val service=StudyService(s,{"synthetic-key"}){_,_,_,_->calls++;HttpBytes(200,emptyMap(),answer())};val old=service.prepare("local:synthetic","question","material",source()).getString("id");val next=service.prepare("local:synthetic","question","material",source()).getString("id")
  assertNotEquals(old,next);service.run(next);assertEquals(1,calls);assertEquals(listOf(next),RequestContinuity.read(s.directory).map{it.id});assertFalse(s.session(old)!!.getBoolean("requestIssued"))
 }
 @Test fun restoredInterruptedFalseWithRetainedFloorCannotCreateOrDispatchAnotherSession()=runBlocking {
  val s=store();var calls=0;val service=StudyService(s,{"synthetic-key"}){_,_,_,_->calls++;HttpBytes(200,emptyMap(),answer())}
  val first=service.prepare("local:synthetic","question","material",source());val old=first.getString("id");val ledger=sealFloor(s,old);s.retireRestoredDispatch();assertEquals("interrupted",s.session(old)!!.getString("status"));assertEquals("not-issued",s.session(old)!!.getString("charge"));val personal=File(s.directory,"personal.json").readBytes();val inputs=inputFiles(s)
  var next:String?=null;var rejected=false
  try {next=service.prepare("local:synthetic","question","material",source()).getString("id");service.run(next)}catch(_:Exception){rejected=true}
  val proof=JSONObject().put("syntheticOnly",true).put("newSessionCreated",next!=null&&next!=old).put("fakeTransportCalls",calls).put("preparedSessionIssuedFlag",s.session(old)!!.getBoolean("requestIssued")).put("oldFloorStillPresent",RequestContinuity.read(s.directory).any{it.id==old}).put("ledgerBytesUnchanged",ledger.contentEquals(File(s.directory,RequestContinuity.FILE).readBytes())).put("personalBytesUnchanged",personal.contentEquals(File(s.directory,"personal.json").readBytes())).put("inputSetUnchanged",inputs==inputFiles(s)).put("rejected",rejected)
  observe("restored-interrupted-floor-only",proof)
  assertTrue("No automatic new session/input/transport or floor rewrite is allowed: $proof",calls==0&&inputs==inputFiles(s)&&ledger.contentEquals(File(s.directory,RequestContinuity.FILE).readBytes())&&personal.contentEquals(File(s.directory,"personal.json").readBytes()))
 }

 @Test fun malformedFloorStopsBeforeAnyNewMaterialOrCredentialRead()=runBlocking {
  val s=store();var keys=0;var calls=0;val service=StudyService(s,{keys++;"synthetic-key"}){_,_,_,_->calls++;HttpBytes(200,emptyMap(),answer())}
  service.prepare("local:synthetic","question","material",source())
  val file=File(s.directory,RequestContinuity.FILE);JsonFiles.write(file,JSONObject().put("contract","wrong-contract").put("requests",JSONArray()))
  val before=s.directory.walkTopDown().filter{it.isFile}.associate{it.relativeTo(s.directory).path to it.readBytes()}
  assertTrue(runCatching{service.prepare("local:synthetic","question","material",source())}.isFailure);assertEquals(0,keys);assertEquals(0,calls)
  val after=s.directory.walkTopDown().filter{it.isFile}.associate{it.relativeTo(s.directory).path to it.readBytes()};assertEquals(before.keys,after.keys);before.forEach{(name,bytes)->assertArrayEquals(name,bytes,after.getValue(name))}
 }
 @Test fun differentFingerprintFloorDoesNotBlockAnExplicitlyDifferentQuestion()=runBlocking {
  val s=store();var calls=0;val service=StudyService(s,{"synthetic-key"}){_,_,_,_->calls++;HttpBytes(200,emptyMap(),answer())}
  val old=service.prepare("local:synthetic","first question","material",source()).getString("id");sealFloor(s,old)
  val next=service.prepare("local:synthetic","different question","material",source()).getString("id");assertNotEquals(old,next);service.run(next)
  assertEquals(1,calls);assertEquals(setOf(old,next),RequestContinuity.read(s.directory).map{it.id}.toSet());assertFalse(s.session(old)!!.getBoolean("requestIssued"))
 }
 @Test fun completeOriginalMaterialsCannotUpgradeAFalseRestoredSessionFlagFromFloorAlone()=runBlocking {
  val s=store();var keys=0;var calls=0;val service=StudyService(s,{keys++;"synthetic-key"}){_,_,_,_->calls++;HttpBytes(200,emptyMap(),answer())}
  val id=service.prepare("local:synthetic","question","material",source()).getString("id");service.run(id)
  s.appendSession(s.session(id)!!.put("status","interrupted").put("requestIssued",false).put("charge","not-issued"))
  val before=s.directory.walkTopDown().filter{it.isFile}.associate{it.relativeTo(s.directory).path to it.readBytes()}
  assertTrue(runCatching{service.prepare("local:synthetic","question","material",source())}.isFailure);assertEquals(1,keys);assertEquals(1,calls)
  assertFalse(s.session(id)!!.getBoolean("requestIssued"));assertEquals("interrupted",s.session(id)!!.getString("status"))
  val after=s.directory.walkTopDown().filter{it.isFile}.associate{it.relativeTo(s.directory).path to it.readBytes()};assertEquals(before.keys,after.keys);before.forEach{(name,bytes)->assertArrayEquals(name,bytes,after.getValue(name))}
 }
}
