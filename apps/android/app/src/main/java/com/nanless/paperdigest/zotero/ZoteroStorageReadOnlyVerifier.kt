package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.zotero.webdav.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS

/** No writes to the original journal, API items or Storage. Download temporaries belong to a new sibling. */
internal class ZoteroStorageReadOnlyVerifier(
 private val researchRoot:File, private val store:ZoteroStorageMigrationStore,
 private val get:suspend(String,Boolean)->JSONObject?,
 private val download:suspend(String,File,Long,()->Unit,(ZoteroOwnedFileReceipt)->Unit)->Unit,
) {
 internal data class Result(val observations:List<MigrationApiObservation>,val adoptions:Map<String,ZoteroDavStorageAdoption>)
 private fun item(reply:JSONObject,key:String,userID:String):JSONObject {
  val library=reply.getJSONObject("library");require(library.optString("type")=="user"&&number(library.opt("id"))?.toString()==userID){"远端文库身份不符"}
  val data=reply.getJSONObject("data");require(reply.optString("key")==key&&data.optString("key")==key&&number(reply.opt("version"))==number(data.opt("version"))&&(number(data.opt("version"))?:0)>0){"远端条目身份或版本不符"};return data
 }
 private fun number(value:Any?):Long?=when(value){is Int->value.toLong();is Long->value;else->null}
 private fun matches(actual:JSONObject,expected:JSONObject){
  expected.keys().forEach{k->if(k !in setOf("version","tags","collections"))require(canonical(actual.opt(k))==canonical(expected.opt(k))){"远端条目已被编辑，未覆盖修改"}}
  expected.optJSONArray("tags")?.objects()?.forEach{tag->require(actual.optJSONArray("tags")?.objects()?.any{candidate->tag.keys().asSequence().all{canonical(candidate.opt(it))==canonical(tag.opt(it))}}==true){"远端附件来源标签不符"}}
  expected.optJSONArray("collections")?.strings()?.forEach{require(actual.optJSONArray("collections")?.strings()?.contains(it)==true){"远端验收分类不符"}}
 }
 suspend fun verify(parent:MigrationParent,target:ZoteroDavTarget,check:()->Unit,child:MigrationChild?=null):Result {
  check();store.requireParent(parent);child?.let{store.requireChild(it);require(it.origin.getString("parentJournalSHA256")==parent.sha256)};val source=parent.header();require(target.userID==source.getString("libraryID"))
  val expectedParent=source.getJSONObject("bibliography").copy().put("key",source.getString("parentKey"))
  if(source.optString("collection").isNotBlank())expectedParent.put("collections",JSONArray().put(source.getString("collection")))
  val firstParent=item(get(source.getString("parentKey"),false)?:error("原书目已不可读"),source.getString("parentKey"),target.userID);matches(firstParent,expectedParent)
  val workRoot=File(researchRoot.parentFile,"ZoteroMigrationWork");BackupCodec.checkedDirectory(researchRoot.parentFile)
  if(!Files.exists(workRoot.toPath(),NOFOLLOW_LINKS))require(workRoot.mkdir());BackupCodec.checkedDirectory(workRoot);BackupCodec.privateDirectory(workRoot)
  val work=Files.createTempDirectory(workRoot.toPath(),"verify-").toFile()
  val workKey=Files.readAttributes(work.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()
  val workRootKey=Files.readAttributes(workRoot.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()
  val owned=linkedMapOf<File,ZoteroOwnedFileReceipt>()
  fun currentWork(){
   BackupCodec.checkedDirectory(workRoot);BackupCodec.checkedDirectory(work)
   require(Files.readAttributes(workRoot.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()==workRootKey)
   require(Files.readAttributes(work.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java,NOFOLLOW_LINKS).fileKey()==workKey)
  }
  var failure:Throwable?=null
  try {
  BackupCodec.privateDirectory(work)
  val observations=mutableListOf<MigrationApiObservation>();val adoptions=mutableMapOf<String,ZoteroDavStorageAdoption>()
  source.getJSONArray("roles").objects().forEachIndexed{i,r->
   check();store.requireParent(parent);val key=r.getString("key");val reply=get(key,true)
   if(reply==null){require(!r.optBoolean("created")&&r.optString("status")!="verified"){"原附件已被删除，未擅自重建"};observations+=MigrationApiObservation(key,false,null,null,null,null,false);return@forEachIndexed}
   val before=item(reply,key,target.userID)
   val expected=JSONObject().put("key",key).put("parentItem",source.getString("parentKey")).put("tags",JSONArray().put(JSONObject().put("tag","PaperDigest:${r.getString("role")}:${r.getString("sha256")}")))
   val file=parent.materialFacts[i].file
   if(r.getBoolean("note"))expected.put("itemType","note").put("note",file.readText())
   else expected.put("itemType","attachment").put("linkMode","imported_file").put("title",r.getString("title")).put("contentType",r.getString("contentType")).put("filename",when(r.getString("contentType")){"application/pdf"->r.getString("role")+".pdf";"text/html"->r.getString("role")+".html";else->r.getString("role")+".json"})
   matches(before,expected)
   val rawMD5=before.opt("md5");val md5=if(!before.has("md5")||rawMD5===JSONObject.NULL)null else (rawMD5 as? String)?.takeIf{it.matches(Regex("[a-f0-9]{32}"))}?:error("远端文件校验值无效")
   val rawTime=before.opt("mtime");val mtime=if(rawTime==null||rawTime===JSONObject.NULL)null else (number(rawTime)?:((rawTime as? String)?.takeIf{it.matches(Regex("[1-9][0-9]{0,12}"))}?.toLong()))?.takeIf{it in 1..9_999_999_999_999L}?:error("远端文件时间无效")
   require(r.getBoolean("note")||(md5==null)==(mtime==null)){"远端文件登记不完整"}
   if(!r.getBoolean("note")&&md5!=null){
    val originalStorage=r.optString("status")=="verified"&&r.optBoolean("uploadTransferred")
    if(!originalStorage){
     // A new migration role may already have its ordinary DAV CAS PATCH after cancellation.
     // It gets no Storage-adoption proof and must resume its original normal DAV journal.
     val existing=requireNotNull(child){"此 Storage 文件没有原完整上传及回读记录，未冒用其登记"}
     val prior=existing.origin.getJSONArray("observations").objects().single{it.getString("key")==key}
     require(prior.isNull("md5")&&prior.isNull("mtime")&&!prior.getBoolean("storageBytesVerified"))
     require(existing.journal.getJSONArray("roles").objects().single{it.getString("key")==key}.optString("davJournalID").isNotBlank())
     observations+=MigrationApiObservation(key,true,number(before.opt("version")),md5,mtime,sha256(canonical(before).toByteArray()),false)
     return@forEachIndexed
    }
    val temporary=File(work,"storage-$i.bin");require(!Files.exists(temporary.toPath(),NOFOLLOW_LINKS));download(key,temporary,parent.materialFacts[i].bytes,check){inode->currentWork();require(!owned.containsKey(temporary));owned[temporary]=inode};check();store.requireParent(parent)
    val after=item(get(key,false)?:error("原附件在读取中消失"),key,target.userID);matches(after,expected);require(canonical(before)==canonical(after)){"远端附件在读取中变化"}
    val material=ZoteroDavAttachment.native(key,source.getString("parentKey"),r.getString("role"),source.getString("paperID"),source.getString("identity"),r.getString("title"),r.getString("contentType"),file,r.getString("sha256"))
    val nativeItem=ZoteroDavApiPort.Item(number(before.opt("version"))!!,md5,mtime)
    adoptions[key]=ZoteroDavStorageAdoption.verified(material,target,parent.sha256,nativeItem,nativeItem,temporary){check();store.requireParentQuick(parent)}
    val temporaryBefore=DavFiles.regular(temporary);check();currentWork();owned.getValue(temporary).requireCurrent();DavFiles.same(temporary,temporaryBefore);require(owned.getValue(temporary).deleteIfCurrent());owned.remove(temporary)
   }else require(r.optString("status")!="verified"||r.getBoolean("note")){"原已核验文件缺少远端登记"}
   observations+=MigrationApiObservation(key,true,number(before.opt("version")),md5,mtime,sha256(canonical(before).toByteArray()),md5!=null&&!r.getBoolean("note"))
  }
  check();store.requireParent(parent)
  val lastParent=item(get(source.getString("parentKey"),false)?:error("原书目在读取中消失"),source.getString("parentKey"),target.userID);matches(lastParent,expectedParent);require(canonical(firstParent)==canonical(lastParent)){"原书目在读取中变化"}
  currentWork();require(work.listFiles()?.isEmpty()==true);return Result(observations,adoptions)
  } catch(e:Throwable){failure=e;throw e} finally {
   try {
   // The receipt identifies only this attempt's native-created files. Never walk unknown
   // entries or a replacement directory; the actual callback is drained before this block.
   currentWork()
   owned.values.forEach{receipt->currentWork();receipt.deleteIfCurrent()}
   currentWork();if(work.listFiles()?.isEmpty()==true)require(work.delete())
   }catch(cleanup:Throwable){val original=failure;if(original!=null)original.addSuppressed(cleanup)else throw cleanup}
  }
 }
}
