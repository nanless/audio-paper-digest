package com.nanless.paperdigest.model

import android.os.Bundle
import android.system.Os
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.FileAlreadyExistsException
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** 只在自有离线模拟器创建合成缓存；默认 Application 启动不在 fixture 保证范围。 */
class CapturePublicationNativeInstrumentedTest {
 private val ins=InstrumentationRegistry.getInstrumentation()
 private fun fixture(block:(File)->Unit){
  val root=Files.createTempDirectory(ins.targetContext.cacheDir.canonicalFile.toPath(),"native-capture-publish-").toRealPath().toFile()
  try{block(root)}finally{Files.walk(root.toPath()).use{paths->paths.sorted(Comparator.reverseOrder()).forEach{Files.delete(it)}}}
 }
 private fun checkpoint(name:String){ins.sendStatus(0,Bundle().apply{putString("capturePublicationNativePhase",name);putBoolean("nativeAssertionsPassed",true)})}
 @Test fun nativePublishesFullBytesAndNeverReplacesForeignTarget(){fixture{root->
  val bytes=ByteArray(2*1024*1024){(it*31).toByte()};val target=File(root,"complete.bin")
  AndroidCapturePublication.publishNew(target,bytes);assertArrayEquals(bytes,target.readBytes());val native=Os.lstat(target.path);assertEquals(1L,native.st_nlink);assertEquals(0x180,native.st_mode and 0x1ff)
  val foreign=File(root,"foreign.bin").apply{writeBytes(byteArrayOf(9,8,7))};val before=Os.lstat(foreign.path)
  val error=runCatching{AndroidCapturePublication.publishNew(foreign,bytes)}.exceptionOrNull();assertTrue(error is FileAlreadyExistsException)
  val after=Os.lstat(foreign.path);assertArrayEquals(byteArrayOf(9,8,7),foreign.readBytes());assertEquals(before.st_dev,after.st_dev);assertEquals(before.st_ino,after.st_ino);assertEquals(before.st_mtim.tv_sec,after.st_mtim.tv_sec);assertEquals(before.st_mtim.tv_nsec,after.st_mtim.tv_nsec)
  assertEquals(setOf("complete.bin","foreign.bin"),root.list()!!.toSet());checkpoint("complete-and-existing-foreign")
 }}
 @Test fun nativeRejectsHigherAncestorLinkForExistingAndMissingTargets(){fixture{root->
  val real=File(root,"real/nested").apply{check(mkdirs())};val alias=File(root,"alias");Files.createSymbolicLink(alias.toPath(),real.parentFile.toPath())
  val foreign=File(real,"foreign.bin").apply{writeBytes(byteArrayOf(3,2,1))};val before=Os.lstat(foreign.path)
  val existing=runCatching{AndroidCapturePublication.publishNew(File(alias,"nested/foreign.bin"),byteArrayOf(8))}.exceptionOrNull()
  val missing=runCatching{AndroidCapturePublication.publishNew(File(alias,"nested/missing.bin"),byteArrayOf(8))}.exceptionOrNull()
  assertTrue(existing is IOException);assertTrue(missing is IOException);assertFalse(File(real,"missing.bin").exists());assertArrayEquals(byteArrayOf(3,2,1),foreign.readBytes())
  val after=Os.lstat(foreign.path);assertEquals(before.st_dev,after.st_dev);assertEquals(before.st_ino,after.st_ino);assertEquals(before.st_mtim.tv_nsec,after.st_mtim.tv_nsec);assertEquals(setOf("foreign.bin"),real.list()!!.toSet());checkpoint("all-ancestor-links-rejected")
 }}
 @Test fun oldPartialStagingResidueCannotBlockOrBecomeFinalResponse(){fixture{root->
  val orphan=File(root,".capture-promotion-${UUID.randomUUID()}.tmp").apply{writeBytes(byteArrayOf(1,2))};val before=Os.lstat(orphan.path)
  val bytes=ByteArray(8193){(it*17).toByte()};val target=File(root,"complete.bin");AndroidCapturePublication.publishNew(target,bytes)
  assertArrayEquals(bytes,target.readBytes());assertArrayEquals(byteArrayOf(1,2),orphan.readBytes());val after=Os.lstat(orphan.path);assertEquals(before.st_dev,after.st_dev);assertEquals(before.st_ino,after.st_ino);assertEquals(setOf(orphan.name,"complete.bin"),root.list()!!.toSet());checkpoint("prior-staging-residue-preserved")
 }}
}
