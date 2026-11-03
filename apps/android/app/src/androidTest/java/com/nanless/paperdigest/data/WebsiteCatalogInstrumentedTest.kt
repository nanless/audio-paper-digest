package com.nanless.paperdigest.data

import androidx.test.core.app.ApplicationProvider
import com.nanless.paperdigest.protocols.ClientProtocols
import android.content.Context
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

/** Native normal sync/reload using explicitly synthetic public responses; no actual HTTP or credentials. */
class WebsiteCatalogInstrumentedTest {
    private fun node(id:String,label:String,parents:List<String>)=JSONObject().put("id",id).put("facet","task").put("zh",label).put("ancestorIds",JSONArray(parents)).put("aliases",JSONArray())
    private val hash="a".repeat(64)
    private fun display():JSONObject {
        val snapshot=JSONObject().put("contract","paper-tag-catalog-snapshot-v2").put("registryVersion","paper-tag-catalog-v2").put("registrySha256",hash).put("concepts",JSONArray().put(node("task.parent","父类",emptyList())).put(node("task.child","子类",listOf("task.parent"))))
        return JSONObject().put("snapshot",snapshot).put("versions",JSONObject().put("contract","paper-tag-catalog-versions-v2").put("currentSha256",hash).put("snapshots",JSONArray().put(snapshot)))
    }
    private fun row(permalink:String,withheld:Boolean=false)=JSONObject().put("pageType","paper").put("title","Synthetic").put("identityStatus","verified").put("sourceKind","arxiv").put("arxivId","2601.00001").put("permalink",permalink)
        .put("tagContract","paper-tag-flat-tags-v2").put("tagCatalogSha256",hash).put("tagPublicationStatus",if(withheld)"withheld"else"").put("tagConcepts",JSONArray().put(JSONObject().put("id","task.child").put("facet","task").put("label","子类")))
    @Test fun normalSyncPersistsPairedAssetsAndAllCurrentGuideRecordsButDoesNotChangePersonalMetadata()=runBlocking {
        val context=ApplicationProvider.getApplicationContext<Context>();val store=PersonalStore(Files.createTempDirectory("website-catalog-").toRealPath().toFile());val before=store.snapshot().toString();val calls=mutableListOf<String>();val pair=display()
        val rows=JSONArray().put(row("posts/one/",true)).put(row("posts/two/"))
        val repo=CatalogRepository(context,store){url,_->calls+=url;when{url.contains("/client/")->throw PublishedHttpStatus(404);url.endsWith("index.json")->rows.toString().toByteArray();url.endsWith("tag-catalog-snapshot.json")->pair.getJSONObject("snapshot").toString().toByteArray();url.endsWith("tag-catalog-versions.json")->pair.getJSONObject("versions").toString().toByteArray();else->error("Unexpected fetch")}}
        repo.sync();assertEquals(6,calls.size);assertEquals(1,repo.summary().getInt("paperCount"));assertEquals(2,WebsiteTaxonomy.records(repo.papers().single{it.id=="arxiv:2601.00001"}).size);assertEquals("子类",repo.websiteTaxonomy()!!.paths(repo.papers().single{it.id=="arxiv:2601.00001"}).single().last().label)
        val restored=CatalogRepository(context,store){_,_->error("Cold reload must not fetch")};assertEquals(listOf("父类","子类"),restored.websiteTaxonomy()!!.paths(restored.papers().single{it.id=="arxiv:2601.00001"}).single().map{it.label});assertEquals(before,store.snapshot().toString())
    }
    @Test fun missingDisplayAssetsNeverDiscardThePublishedPapersOrInventHierarchy()=runBlocking {
        val context=ApplicationProvider.getApplicationContext<Context>();val store=PersonalStore(Files.createTempDirectory("website-missing-").toRealPath().toFile())
        val repo=CatalogRepository(context,store){url,_->if(url.contains("/client/"))throw PublishedHttpStatus(404) else if(url.endsWith("index.json"))JSONArray().put(row("posts/one/")).toString().toByteArray()else error("Synthetic missing website assets")}
        repo.sync();assertEquals(1,repo.summary().getInt("paperCount"));assertNull(repo.websiteTaxonomy());assertEquals("unavailable",repo.summary().getString("websiteTaxonomyStatus"));assertEquals(1,WebsiteTaxonomy.records(repo.papers().single{it.id=="arxiv:2601.00001"}).size)
    }
    @Test fun failedAssetRefreshRetainsOnlyVersionMatchedCachedClassification()=runBlocking {
        val context=ApplicationProvider.getApplicationContext<Context>();val store=PersonalStore(Files.createTempDirectory("website-cached-").toRealPath().toFile());val pair=display();var missing=false
        val repo=CatalogRepository(context,store){url,_->when{url.contains("/client/")->throw PublishedHttpStatus(404);url.endsWith("index.json")->JSONArray().put(row("posts/one/")).put(row("posts/new/").put("arxivId","2601.00002").put("tagCatalogSha256","b".repeat(64))).toString().toByteArray();missing->error("Synthetic unavailable display assets");url.endsWith("tag-catalog-snapshot.json")->pair.getJSONObject("snapshot").toString().toByteArray();else->pair.getJSONObject("versions").toString().toByteArray()}}
        repo.sync();missing=true;repo.sync();assertEquals("cached-unavailable",repo.summary().getString("websiteTaxonomyStatus"));val graph=repo.websiteTaxonomy()!!
        assertFalse(graph.paths(repo.papers().first{it.id=="arxiv:2601.00001"}).isEmpty());assertTrue(graph.paths(repo.papers().first{it.id=="arxiv:2601.00002"}).isEmpty());assertEquals("unknown-version",graph.status(repo.papers().first{it.id=="arxiv:2601.00002"}))
        val restored=CatalogRepository(context,store){_,_->error("No cold fetch")};assertEquals("cached-unavailable",restored.summary().getString("websiteTaxonomyStatus"));assertNotNull(restored.websiteTaxonomy())
    }

    @Test fun coldCatalogKeepsOriginalFormatAndRejectsMixedHeaders()=runBlocking {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val store=PersonalStore(Files.createTempDirectory("website-local-format-").toRealPath().toFile())
        val repo=CatalogRepository(context,store){url,_->
            if(url==CatalogRepository.SITE+"index.json")JSONArray().put(row("posts/one/")).toString().toByteArray()
            else throw PublishedHttpStatus(404)
        }
        repo.sync()
        val file=store.directory.resolve("PublishedLibrary/current.json")
        val current=JSONObject(file.readText())
        val family="paperdigest-published-library"
        assertTrue(ClientProtocols.isCurrentHeader(current,family))
        assertEquals(1,CatalogRepository(context,store).summary().getInt("paperCount"))
        current.remove("contract");current.remove("schemaFingerprint")
        val original=current.put("format","mac-published-library-v1").toString()
        file.writeText(original)
        assertEquals(1,CatalogRepository(context,store).summary().getInt("paperCount"))
        assertEquals(original,file.readText())
        val mixed=current.put("schemaFingerprint",ClientProtocols.schemaFingerprint(family)).toString()
        file.writeText(mixed)
        assertTrue(runCatching{CatalogRepository(context,store)}.isFailure)
        assertEquals(mixed,file.readText())
    }

    @Test fun taxonomyEndpointCannotBorrowTheOtherRegisteredFormat()=runBlocking {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val old=display()
        val current=JSONObject()
        for((key,family) in listOf("snapshot" to "paper-tag-catalog-snapshot","versions" to "paper-tag-catalog-versions")){
            val fields=JSONObject(old.getJSONObject(key).toString()).apply{remove("contract")}
            current.put(key,ClientProtocols.record(family,fields))
        }
        for((route,pair) in listOf("client/data/" to old,"data/" to current)){
            val store=PersonalStore(Files.createTempDirectory("website-wrong-taxonomy-").toRealPath().toFile())
            val calls=mutableListOf<String>()
            val repo=CatalogRepository(context,store){url,_->
                val path=url.removePrefix(CatalogRepository.SITE);calls+=path
                when(path){
                    "index.json"->JSONArray().put(row("posts/one/")).toString().toByteArray()
                    route+"tag-catalog-snapshot.json"->pair.getJSONObject("snapshot").toString().toByteArray()
                    route+"tag-catalog-versions.json"->pair.getJSONObject("versions").toString().toByteArray()
                    else->throw PublishedHttpStatus(404)
                }
            }
            repo.sync();assertNull(repo.websiteTaxonomy())
            assertEquals("unavailable",repo.summary().getString("websiteTaxonomyStatus"))
            if(route.startsWith("client"))assertFalse(calls.any{it.startsWith("data/")})
        }
    }

}
