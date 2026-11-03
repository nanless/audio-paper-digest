package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.data.PersonalStore

import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.lang.reflect.InvocationTargetException
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject

/** Official response shape, public default app path only; no account/key/network/user data. */
class CloudArchiveTest {
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
    private val personalRoot = "/dav/PaperDigest/"
    private val legacyRoot = personalRoot + "personal-sync-v1/"
    private val revisionRoot = personalRoot + "personal-sync-revisions-v1/"

    private fun personalDocument(revision: Long, payload: String, legacy: Any? = null) =
        JSONObject().put("format", "paperdigest-personal-sync-v1").put("device", id).put("revision", revision)
            .put("payload", payload).apply { if (legacy != null) put("legacySHA256", legacy) }.toString().toByteArray()

    private fun revisionPath(revision: Long, body: ByteArray) =
        "$revisionRoot$id/${PersonalWebDavSync.bucket(revision)}/$id-$revision-${BackupCodec.hash(body)}.json"

    private inner class PersonalDAV {
        val collections = mutableSetOf(personalRoot)
        val objects = mutableMapOf<String, ByteArray>()
        val puts = mutableListOf<String>()
        var loseWriteResponse = false
        var createRace = false

        fun service(owner: String = id) = CloudArchive("PaperDigest", owner, { CloudCredentials("fixture", "fixture") }, {},
            CloudTransport { request, _ ->
                val path = request.url.encodedPath
                when (request.method) {
                    "MKCOL" -> CloudHTTP(if (collections.add(path)) 201 else 405, emptyMap(), byteArrayOf())
                    "PROPFIND" -> if (path !in collections) CloudHTTP(404, emptyMap(), byteArrayOf()) else {
                        val members = mutableListOf(path to true)
                        if (request.header("Depth") == "1") {
                            members += collections.filter { it != path && it.startsWith(path) && '/' !in it.removePrefix(path).removeSuffix("/") }.map { it to true }
                            members += objects.keys.filter { it.startsWith(path) && '/' !in it.removePrefix(path) }.map { it to false }
                        }
                        CloudHTTP(207, emptyMap(), xml(members))
                    }
                    "GET" -> CloudHTTP(if (path in objects) 200 else 404, emptyMap(), objects[path] ?: byteArrayOf())
                    "PUT" -> {
                        assertTrue(path.startsWith(revisionRoot))
                        assertEquals("*", request.header("If-None-Match"))
                        assertNull(request.header("If-Match"))
                        val buffer = Buffer()
                        request.body!!.writeTo(buffer)
                        puts += path
                        objects[path] = buffer.readByteArray()
                        if (loseWriteResponse) throw java.io.IOException("fixture disconnected after saving")
                        CloudHTTP(if (createRace) 412 else 201, emptyMap(), byteArrayOf())
                    }
                    else -> error("Unexpected WebDAV method")
                }
            }, { 1792886400000L }, {}, 0)
    }

    @Test fun noEtagMigratesWithoutMutatingLegacyAndReadsLatestAcrossBuckets() = runTest {
        val dav = PersonalDAV()
        val legacy = personalDocument(255, "old")
        val legacyPath = "$legacyRoot$id.json"
        dav.collections += legacyRoot
        dav.objects[legacyPath] = legacy
        val client = dav.service()
        val before = client.personalDocuments()
        assertArrayEquals(legacy, before.heads.getValue(id))
        val pin = BackupCodec.hash(legacy)
        val first = personalDocument(256, "favorite", pin)
        client.writePersonalDocument(first, before)
        val observed = client.personalDocuments()
        assertArrayEquals(first, observed.heads.getValue(id))
        val second = personalDocument(257, "note", pin)
        dav.createRace = true // Another identical creation reaches the server first.
        client.writePersonalDocument(second, observed)
        dav.collections += "$revisionRoot$id/2/" // An interrupted writer only created this collection.
        assertArrayEquals(second, client.personalDocuments().heads.getValue(id))
        assertEquals(listOf(revisionPath(256, first), revisionPath(257, second)), dav.puts)
        assertArrayEquals(legacy, dav.objects.getValue(legacyPath))
        dav.objects[legacyPath] = personalDocument(256, "an old client wrote again")
        assertTrue(runCatching { client.personalDocuments() }.isFailure)
        assertArrayEquals(second, dav.objects.getValue(revisionPath(257, second)))
    }

    @Test fun immutablePersonalRetryAndForkDoNotOverwriteAnyOriginal() = runTest {
        val dav = PersonalDAV()
        val client = dav.service()
        val empty = client.personalDocuments()
        assertTrue(empty.heads.isEmpty())
        val first = personalDocument(1, "Mac edit", JSONObject.NULL)
        val second = personalDocument(1, "Android edit", JSONObject.NULL)
        dav.loseWriteResponse = true
        assertTrue(runCatching { client.writePersonalDocument(first, empty) }.isFailure)
        dav.loseWriteResponse = false
        client.writePersonalDocument(first, empty)
        assertEquals(1, dav.puts.size)
        assertArrayEquals(first, client.personalDocuments().heads.getValue(id))
        client.writePersonalDocument(second, empty)
        assertEquals(2, dav.puts.size)
        assertArrayEquals(first, dav.objects.getValue(revisionPath(1, first)))
        assertArrayEquals(second, dav.objects.getValue(revisionPath(1, second)))
        assertTrue(runCatching { client.personalDocuments() }.isFailure)
        dav.objects.remove(revisionPath(1, second))
        dav.objects[revisionPath(1, first)] = second
        assertTrue(runCatching { client.personalDocuments() }.isFailure)
    }

    @Test fun noEtagPeerChangesApplyInBothDirectionsAfterReadingLegacyDocuments() = runTest {
        val dav = PersonalDAV()
        val other = "00000000-0000-4000-8000-000000000002"
        val originalPaper = "arxiv:2610.00001"
        val temporaryPaper = "arxiv:2610.00002"
        val mac = dav.service()
        val android = dav.service(other)
        suspend fun sync(client: CloudArchive, owner: String, local: JSONObject): JSONObject {
            val observed = client.personalDocuments()
            val plan = PersonalWebDavSync.plan(local, owner, observed.heads)
            plan.upload?.let { client.writePersonalDocument(it, observed) }
            assertEquals(0, plan.conflicts)
            return plan.personal
        }
        val existing = PersonalStore.initial().put("favorites", JSONArray().put(originalPaper))
        val initial = PersonalWebDavSync.plan(existing, id, emptyMap()).upload!!
        val legacy = JSONObject(initial.decodeToString()).apply { remove("legacySHA256") }.toString().toByteArray()
        dav.collections += legacyRoot
        dav.objects["$legacyRoot$id.json"] = legacy
        var onMac = sync(mac, id, existing)
        var onAndroid = sync(android, other, PersonalStore.initial())
        onAndroid.getJSONArray("favorites").put(temporaryPaper)
        onAndroid = sync(android, other, onAndroid)
        onMac = sync(mac, id, onMac)
        assertEquals(temporaryPaper, onMac.getJSONArray("favorites").getString(1))
        onMac.getJSONObject("notes").put(temporaryPaper, JSONObject().put("revision", 1).put("text", "temporary Mac note"))
        onMac = sync(mac, id, onMac)
        onAndroid = sync(android, other, onAndroid)
        assertEquals("temporary Mac note", onAndroid.getJSONObject("notes").getJSONObject(temporaryPaper).getString("text"))
        onAndroid.put("favorites", JSONArray().put(originalPaper))
        onMac.getJSONObject("notes").remove(temporaryPaper)
        onAndroid = sync(android, other, onAndroid)
        onMac = sync(mac, id, onMac)
        onAndroid = sync(android, other, onAndroid)
        assertEquals(JSONArray().put(originalPaper).toString(), onMac.getJSONArray("favorites").toString())
        assertFalse(onAndroid.getJSONObject("notes").has(temporaryPaper))
        assertArrayEquals(legacy, dav.objects.getValue("$legacyRoot$id.json"))
    }

    @Test fun monthAndUuidAliasesKeepOneLevelCanonicalPathsAndDuplicateNormalizationIsNotCompletion() = runTest {
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
