package com.nanless.paperdigest.zotero.webdav

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** Native, process-local proof of one unchanged Storage object; no JSON flag can issue it. */
internal class ZoteroDavStorageAdoption private constructor(
 private val target: String,
 private val descriptor: String,
 private val parentJournalSHA256: String,
 private val item: ZoteroDavApiPort.Item,
 private val bytes: Long,
 private val sha256: String,
 private val current: () -> Unit,
) {
 fun requireCurrent(){current()}
 fun binding():JSONObject=JSONObject().put("contract","zotero-storage-adoption-v1").put("parentJournalSHA256",parentJournalSHA256).put("apiVersion",item.version).put("md5",item.md5).put("mtime",item.mtime).put("bytes",bytes).put("sha256",sha256)
 fun wireMtime(material:ZoteroDavAttachment,nativeTarget:ZoteroDavTarget):Long {
  current();davRequire(canonical(nativeTarget.binding())==target&&canonical(material.descriptor())==descriptor&&material.sourceSHA256==sha256,"stale")
  return item.mtime?:throw ZoteroDavFailure("apiMetadata")
 }
 fun requireFile(md5:String,count:Long,fileSHA:String){current();davRequire(md5==item.md5&&count==bytes&&fileSHA==sha256,"sourceChanged")}
 fun requirePlan(plan:JSONObject,nativeTarget:ZoteroDavTarget){
  current();davRequire(canonical(nativeTarget.binding())==target&&canonical(plan.getJSONObject("attachment"))==descriptor&&canonical(plan.optJSONObject("storageAdoption"))==canonical(binding()),"stale")
  val file=plan.getJSONObject("file");davRequire(file.getLong("bytes")==bytes&&file.getString("sha256")==sha256&&file.getString("md5")==item.md5&&file.getLong("mtime")==item.mtime,"sourceChanged")
 }
 fun requireItem(observed:ZoteroDavApiPort.Item){current();davRequire(observed==item,"conflict")}
 companion object {
  /** Called only after ordinary API identity validation and a full Storage GET in a new sibling workspace.
   * Both original and download are read again here; the normal API before/after objects must be equal. */
  fun verified(material:ZoteroDavAttachment,target:ZoteroDavTarget,parentJournalSHA256:String,before:ZoteroDavApiPort.Item,after:ZoteroDavApiPort.Item,download:File,check:()->Unit):ZoteroDavStorageAdoption {
   check();shaField(parentJournalSHA256);davRequire(before==after&&before.version>0&&before.md5?.matches(Regex("[a-f0-9]{32}"))==true&&before.mtime?.let{it in 1..9_999_999_999_999L}==true,"conflict")
   fun facts(file:File,limit:Long=ZoteroDavCodec.MAX_FILE):Triple<Long,String,String>{
    val stamp=DavFiles.regular(file);val sha=MessageDigest.getInstance("SHA-256");val md5=MessageDigest.getInstance("MD5");var size=0L
    java.nio.channels.FileChannel.open(file.toPath(),java.nio.file.StandardOpenOption.READ,java.nio.file.LinkOption.NOFOLLOW_LINKS).use{input->val buffer=java.nio.ByteBuffer.allocate(65536);while(true){check();buffer.clear();val n=input.read(buffer);if(n<0)break;davRequire(n>0,"storage");size+=n;davRequire(size<=limit,"limit");sha.update(buffer.array(),0,n);md5.update(buffer.array(),0,n)}}
    DavFiles.same(file,stamp);return Triple(size,davHex(sha.digest()),davHex(md5.digest()))
   }
   val source=facts(material.source);val remote=facts(download,source.first)
   davRequire(source.first>0&&source==remote&&source.second==material.sourceSHA256&&source.third==before.md5,"sourceChanged");check()
   return ZoteroDavStorageAdoption(canonical(target.binding()),canonical(material.descriptor()),parentJournalSHA256,before,source.first,source.second,check)
  }
 }
}
