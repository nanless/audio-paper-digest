package com.nanless.paperdigest.cloud

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.lang.reflect.InvocationTargetException

/** Official response shape, public default app path only; no account/key/network/user data. */
class CloudArchiveAndroidXMLTest {
    private val monthPath="/dav/PaperDigest/2026-10/"
    private val id="00112233-4455-6677-8899-aabbccddeeff"
    private fun xml(members:List<Pair<String,Boolean>>) = ("<d:multistatus xmlns:d=\"DAV:\">"+members.joinToString(""){(href,collection)->
        "<d:response><d:href>$href</d:href><d:propstat><d:prop><d:resourcetype>${if(collection)"<d:collection/>" else ""}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
    }+"</d:multistatus>").toByteArray()
    private fun requireCollection(bytes:ByteArray,path:String) {
        val method=CloudArchive.Companion::class.java.getDeclaredMethod("requireCollection",ByteArray::class.java,String::class.java).apply{isAccessible=true}
        try {method.invoke(CloudArchive.Companion,bytes,path)}catch(e:InvocationTargetException){throw e.targetException}
    }
    private fun rejected(bytes:ByteArray,path:String=monthPath) {
        val e=runCatching{requireCollection(bytes,path)}.exceptionOrNull()
        assertTrue("Expected the safe DAV integrity failure",e is CloudFailure && e.code=="incompleteListing")
    }
    @Test fun actualOfficialMonthDepthZeroCanIdentifySuccessfulCollectionWithoutTrailingSlash() {
        // Exact 396-byte shape captured from the official read-only response;
        // contains only the app's default folder/month, empty etag and MIME.
        val official="""<?xml version="1.0" encoding="UTF-8" standalone="no"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com"><d:response><d:href>/dav/PaperDigest/2026-10</d:href><d:propstat><d:prop><d:getetag/><d:getcontenttype>httpd/unix-directory</d:getcontenttype><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>""".toByteArray()
        assertEquals(396,official.size);requireCollection(official,monthPath)
        requireCollection(xml(listOf(monthPath to true)),monthPath)
    }
    @Test fun onlySuccessfulCollectionsReceiveSlashAliasAndAmbiguousUrisRemainRejected() {
        rejected(xml(listOf(monthPath.dropLast(1) to false)))
        for(href in listOf("https://evil.invalid$monthPath","https://user@dav.jianguoyun.com$monthPath",monthPath+"?x=1",monthPath+"#x",
            monthPath+"/","/dav/PaperDigest/%32%30%32%36-10","/dav/PaperDigest%2F2026-10","/dav/PaperDigest/%2e%2e/2026-10",
            "/dav/PaperDigest/../PaperDigest/2026-10","dav/PaperDigest/2026-10","//dav.jianguoyun.com$monthPath","/dav/PaperDigest\\2026-10"))rejected(xml(listOf(href to true)))
        val failed="""<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/PaperDigest/2026-10</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat><d:propstat><d:prop><d:displayname>unrelated success</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>""".toByteArray()
        rejected(failed)
    }
    @Test fun monthAndUuidAliasesKeepOneLevelCanonicalPathsAndDuplicateNormalizationIsNotCompletion() = runBlocking {
        val cases=listOf(
            xml(listOf(monthPath.dropLast(1) to true,(monthPath+id) to true)) to true,
            xml(listOf(monthPath to true,monthPath.dropLast(1) to true)) to false,
            xml(listOf(monthPath to true,(monthPath+id) to true,(monthPath+id+"/") to true)) to false,
            xml(listOf(monthPath to true,(monthPath+id) to false,(monthPath+id+"/") to true)) to false,
            xml(listOf(monthPath to true,(monthPath+id.uppercase()) to true)) to false,
            xml(listOf(monthPath to true,(monthPath+id+"/nested/") to true)) to false)
        for((body,allowed)in cases) {
            val calls=mutableListOf<String>()
            val transport=CloudTransport{request,_->calls+=request.method;if(request.method=="PROPFIND")CloudHTTP(207,emptyMap(),body)else CloudHTTP(404,emptyMap(),byteArrayOf())}
            val service=CloudArchive("PaperDigest","00000000-0000-4000-8000-000000000002",{CloudCredentials("fixture","fixture")},{},transport,{1792886400000L},{},0)
            val result=runCatching{service.list("2026-10")}
            if(allowed){assertTrue(result.isSuccess);assertEquals(emptyList<CloudManifest>(),result.getOrThrow());assertEquals(listOf("PROPFIND","GET"),calls)}
            else {assertTrue(result.isFailure);assertEquals(listOf("PROPFIND"),calls)}
        }
    }
}
