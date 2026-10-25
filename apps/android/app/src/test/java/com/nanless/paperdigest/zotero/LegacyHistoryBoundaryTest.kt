package com.nanless.paperdigest.zotero
import org.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID
class LegacyHistoryBoundaryTest {
 private fun value(id:String)=JSONObject().put("id",id).put("serverID","synthetic-local-origin").put("fingerprint","a".repeat(64)).put("parentKey","ABCDEFGH").put("request",JSONObject().put("identity","synthetic:original").put("bibliography",JSONObject().put("title","Original \uFFFD title"))).put("steps",JSONArray().put(JSONObject().put("role","bibliography").put("key","ABCDEFGH").put("verified",true)))
 @Test fun invalidUtf8CannotBeReplacedIntoACompleteHistoricalRecord() {
  val root=Files.createTempDirectory("legacy-history-utf8-").toRealPath().toFile();try{val id=UUID.randomUUID().toString();val dir=File(root,"zotero-archives").apply{mkdir()};val good=value(id).toString().toByteArray();val index=good.indices.first{it+2<good.size&&good[it]==0xef.toByte()&&good[it+1]==0xbf.toByte()&&good[it+2]==0xbd.toByte()};val raw=good.copyOfRange(0,index)+byteArrayOf(0xff.toByte())+good.copyOfRange(index+3,good.size);val file=File(dir,"$id.json").apply{writeBytes(raw)}
   val result=LegacyMacArchiveHistory.read(root);assertEquals(0,result.getJSONArray("records").length());assertEquals(1,result.getInt("unreadableCount"));assertArrayEquals(raw,file.readBytes())
  }finally{root.deleteRecursively()}
 }
 @Test fun controlledResearchRootLinkCannotReadAnOutsideHistoricalRecord() {
  val parent=Files.createTempDirectory("legacy-history-root-link-").toRealPath().toFile();try{val outside=File(parent,"outside").apply{mkdir()};val dir=File(outside,"zotero-archives").apply{mkdir()};val id=UUID.randomUUID().toString();val file=File(dir,"$id.json").apply{writeText(value(id).toString())};val original=file.readBytes();val alias=File(parent,"controlled-root-link");Files.createSymbolicLink(alias.toPath(),outside.toPath())
   val result=LegacyMacArchiveHistory.read(alias);assertEquals(0,result.getJSONArray("records").length());assertEquals(1,result.getInt("unreadableCount"));assertArrayEquals(original,file.readBytes())
  }finally{parent.deleteRecursively()}
 }
}
