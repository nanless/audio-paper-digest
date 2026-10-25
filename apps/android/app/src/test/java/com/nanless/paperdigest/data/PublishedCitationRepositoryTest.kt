package com.nanless.paperdigest.data

import kotlinx.coroutines.*
import org.json.JSONObject
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Two exact previously fetched published cases; altered variants are explicitly synthetic negatives. No live HTTP/credentials/model. */
class PublishedCitationRepositoryTest {
 private fun bytes(name:String)=javaClass.classLoader!!.getResourceAsStream("published-citation-v1/$name")!!.use{it.readBytes()}
 private val manifest get()=JSONObject(PublishedUtf8.decode(bytes("public-source-manifest.json")))
 private fun fixture(kind:String,block:suspend(Fixture)->Unit)=runBlocking{
  val parent=Files.createTempDirectory("published-citation-").toRealPath().toFile()
  try{val row=manifest.getJSONArray("records").objects().single{it.getString("kind")==kind};val paper=CatalogRepository.parsePaper(JSONObject(PublishedUtf8.decode(bytes(row.getString("rowFile")))))!!
   val responses=linkedMapOf<String,ByteArray>();val page=row.getJSONObject("page");val pageBytes=bytes(page.getString("name"));assertEquals(page.getString("sha256"),sha256(pageBytes));responses[page.getString("url")]=pageBytes
   row.getJSONArray("sidecars").objects().forEach{source->val raw=bytes(source.getString("name"));assertEquals(source.getString("sha256"),sha256(raw));responses[source.getString("url")]=raw}
   block(Fixture(parent,paper,responses))
  }finally{parent.deleteRecursively()}
 }
 private class Fixture(val parent:File,val paper:Paper,val responses:MutableMap<String,ByteArray>){
  val directory=File(parent,"Research/CitationOriginals").canonicalFile
  val calls=mutableListOf<String>()
  val repo=PublishedCitationRepository(directory){url,limit->calls+=url;val value=responses[url]?:error("Unexpected synthetic transport request");require(value.size<=limit);value.copyOf()}
  suspend fun bound(repository:PublishedCitationRepository=repo):Article {val page=repository.fetchPage(paper);try{val a=CatalogRepository.extractArticle(page.html,paper,"fixture-actual-catalog");return repository.bindPage(paper,a,page)}finally{repository.releasePage(page)}}
  fun address(format:PublishedCitationRepository.Format)=responses.keys.single{it.endsWith('/'+format.filename)}
  fun artifactFiles()=directory.walkTopDown().filter{it.isFile&&it.parentFile.name in listOf("raw","receipts")}.toList()
 }
 @Test fun actualMiclaThreeFormatsAreExactPublishedOriginalBytesWithHonestSingleFileScope()=fixture("arxiv-micla"){f->
  val article=f.bound()
  for(format in PublishedCitationRepository.Format.entries){val raw=f.responses.getValue(f.address(format));val original=f.repo.original(f.paper,article,format);assertArrayEquals(raw,original.bytes);assertEquals(sha256(raw),original.sha256);assertEquals(f.address(format),original.sourceURL);assertEquals(false,original.metadata().get("bundleHashVerified"));assertTrue(original.metadata().isNull("publishedSHA256"));val changed=original.bytes;changed[0]=0;assertArrayEquals(raw,original.bytes);original.metadata().put("bundleHashVerified",true);assertEquals(false,original.metadata().get("bundleHashVerified"))}
  assertEquals(4,f.calls.size)
  assertTrue(PublishedUtf8.decode(f.repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX).bytes).contains("archivePrefix = {arXiv}"))
  val ris=PublishedUtf8.decode(f.repo.original(f.paper,article,PublishedCitationRepository.Format.RIS).bytes);assertTrue(ris.contains("ID  - 2610.27491v1"));assertTrue(ris.contains("L1  - https://arxiv.org/pdf/2610.27491v1.pdf"));assertEquals(4,f.calls.size)
 }
 @Test fun actualTurnGuideHasNoPublishedOriginalAndNeverFabricatesAnEprint()=fixture("conference-turnguide"){f->
  val article=f.bound();for(format in PublishedCitationRepository.Format.entries){val error=runCatching{f.repo.original(f.paper,article,format)}.exceptionOrNull();assertTrue(error is AppFailure);assertEquals("citationUnavailable",(error as AppFailure).category)}
  assertEquals(listOf(f.paper.blogURL),f.calls);assertTrue(f.artifactFiles().isEmpty())
 }
 @Test fun syntheticLocalUnknownMetadataNeverAcquiresPublicationTypeOrNetworkPermission()=fixture("arxiv-micla"){f->
  val local=Paper("local:"+"a".repeat(64),"Explicit synthetic local PDF",sourceKind="local",identityStatus="unverified")
  val article=Article(local.id,"<p>local</p>","local","","",sha256("local".toByteArray()),now())
  for(format in PublishedCitationRepository.Format.entries)assertTrue(runCatching{f.repo.original(local,article,format)}.isFailure)
  assertTrue(f.calls.isEmpty());assertTrue(f.artifactFiles().isEmpty())
 }
 @Test fun anOldSameOwnerArticleCannotBindToDifferentPublishedRawRevision()=fixture("arxiv-micla"){f->
  val page=f.repo.fetchPage(f.paper);val fresh=CatalogRepository.extractArticle(page.html,f.paper);val old=fresh.copy(html="<p>Explicit synthetic old body</p>",revisionSHA256=sha256("old body".toByteArray()));val before=canonical(old.json())
  val error=runCatching{f.repo.bindPage(f.paper,old,page)}.exceptionOrNull();assertTrue(error is IllegalArgumentException);assertTrue(error!!.message!!.contains("不是同一修订"));assertEquals(before,canonical(old.json()));assertTrue(f.directory.walkTopDown().none{it.isFile})
 }
 @Test fun coldOfflineReadReplaysTheOriginalPageAndFormatInsteadOfFetchingLatest()=fixture("arxiv-micla"){f->
  val article=f.bound();val original=f.repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX);val cold=PublishedCitationRepository(f.directory){_,_->error("Offline read made an HTTP request")}
  assertArrayEquals(original.bytes,cold.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX,offline=true).bytes)
  val pageSHA=article.original!!.getJSONObject(PublishedCitationRepository.PAGE_FIELD).getString("pageSHA256");val page=File(f.directory,"pages/$pageSHA.html");page.appendText(" ")
  assertTrue(runCatching{cold.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX,offline=true)}.isFailure);assertArrayEquals(original.bytes,File(f.directory,"raw/${original.sha256}.bib").readBytes())
 }
 @Test fun noJsonLinkCanAuthorizeGuessedBibtexSiblingEvenWhenTheServerWouldReturnIt()=fixture("arxiv-micla"){f->
  val doc=Jsoup.parse(PublishedUtf8.decode(f.responses.getValue(f.paper.blogURL)));doc.select("a[href]").filter{it.attr("href").endsWith("/citation.bib")}.forEach{it.remove()};f.responses[f.paper.blogURL]=doc.outerHtml().toByteArray()
  val article=f.bound();assertTrue(runCatching{f.repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX)}.exceptionOrNull() is AppFailure);assertEquals(listOf(f.paper.blogURL),f.calls)
  val json=f.repo.original(f.paper,article,PublishedCitationRepository.Format.JSON);assertArrayEquals(f.responses.getValue(f.address(PublishedCitationRepository.Format.JSON)),json.bytes);assertFalse(f.calls.contains(f.address(PublishedCitationRepository.Format.BIBTEX)))
 }
 @Test fun sameAddressChangedBytesCannotOverwriteAnAlreadyVerifiedOriginal()=fixture("arxiv-micla"){f->
  val article=f.bound();val first=f.repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX);val before=f.artifactFiles().associate{it.relativeTo(f.directory).path to sha256(it.readBytes())}
  val url=f.address(PublishedCitationRepository.Format.BIBTEX);f.responses[url]=f.responses.getValue(url)+"\n".toByteArray()
  assertTrue(runCatching{f.repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX,verifyRemote=true)}.isFailure)
  assertArrayEquals(first.bytes,f.repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX,offline=true).bytes);assertEquals(before,f.artifactFiles().associate{it.relativeTo(f.directory).path to sha256(it.readBytes())})
 }
 @Test fun legacyInferredCitationFilesAndBundleAddressesDoNotReplaceActualPageProvenance()=fixture("arxiv-micla"){f->
  val actual=CatalogRepository.extractArticle(PublishedUtf8.decode(f.responses.getValue(f.paper.blogURL)),f.paper);val legacy=actual.copy(original=actual.json().put("citationFiles",JSONObject().put("citation.bib",f.address(PublishedCitationRepository.Format.BIBTEX))))
  assertTrue(runCatching{f.repo.original(f.paper,legacy,PublishedCitationRepository.Format.BIBTEX,offline=true)}.exceptionOrNull() is AppFailure);assertTrue(f.calls.isEmpty())
 }
 @Test fun wrongVersionsInEachRealFormatAreRejectedWithoutAnyReadyArtifact()=fixture("arxiv-micla"){f->
  val article=f.bound()
  for(format in PublishedCitationRepository.Format.entries){val url=f.address(format);val raw=f.responses.getValue(url);f.responses[url]=PublishedUtf8.decode(raw).replace("2610.27491v1","2610.27491v2").toByteArray();assertTrue(runCatching{f.repo.original(f.paper,article,format)}.isFailure);f.responses[url]=raw}
  assertTrue(f.artifactFiles().isEmpty())
 }
 @Test fun contradictoryVersionAndDuplicateJsonKeysDoNotPassThroughPlatformLeniency()=fixture("arxiv-micla"){f->
  val article=f.bound();val format=PublishedCitationRepository.Format.JSON;val url=f.address(format);val raw=f.responses.getValue(url);val text=PublishedUtf8.decode(raw)
  for(bad in listOf(text.replace("\"arxivVersion\": 1","\"arxivVersion\": 2"),text.replaceFirst("{","{\"id\":\"different-owner\","),text+"{}",text+" // not JSON")) {f.responses[url]=bad.toByteArray();assertTrue(runCatching{f.repo.original(f.paper,article,format)}.isFailure)}
  assertTrue(f.artifactFiles().isEmpty())
 }
 @Test fun malformedUtf8HtmlAndTruncatedFormatsCannotBecomeCitationOriginals()=fixture("arxiv-micla"){f->
  val article=f.bound()
  for(format in PublishedCitationRepository.Format.entries){val url=f.address(format);val raw=f.responses.getValue(url);for(bad in listOf(byteArrayOf(0xc3.toByte(),0x28),"<!doctype html><html>404</html>".toByteArray(),raw.copyOf(raw.size/2))){f.responses[url]=bad;assertTrue(runCatching{f.repo.original(f.paper,article,format)}.isFailure)};f.responses[url]=raw}
  assertTrue(f.artifactFiles().isEmpty())
 }
 @Test fun externalAndAmbiguousPerFormatLinksNeverReceiveARequest()=fixture("arxiv-micla"){f->
  val originalPage=f.responses.getValue(f.paper.blogURL);val doc=Jsoup.parse(PublishedUtf8.decode(originalPage));val anchor=doc.select("a[href]").first{it.attr("href").endsWith("/citation.bib")};anchor.attr("href","https://evil.invalid/citation.bib");f.responses[f.paper.blogURL]=doc.outerHtml().toByteArray()
  val a=f.bound();assertTrue(runCatching{f.repo.original(f.paper,a,PublishedCitationRepository.Format.BIBTEX)}.isFailure);assertEquals(listOf(f.paper.blogURL),f.calls)
  val second=Jsoup.parse(PublishedUtf8.decode(originalPage));second.body().appendElement("a").attr("href","/audio-paper-digest-blog/data/papers/explicit-synthetic/citation.bib").text("Synthetic second file");f.responses[f.paper.blogURL]=second.outerHtml().toByteArray()
  val b=f.bound();assertTrue(runCatching{f.repo.original(f.paper,b,PublishedCitationRepository.Format.BIBTEX)}.isFailure);assertEquals(listOf(f.paper.blogURL,f.paper.blogURL),f.calls)
 }
 @Test fun explicitSyntheticKnownDoiVenueAndDateRemainOriginalNotClientRebuiltFields()=fixture("arxiv-micla"){f->
  val article=f.bound();val bibURL=f.address(PublishedCitationRepository.Format.BIBTEX);val bib=PublishedUtf8.decode(f.responses.getValue(bibURL)).trimEnd();val modified=bib.dropLast(1)+",\n  doi = {10.0000/explicit-synthetic-fixture},\n  booktitle = {Explicit synthetic venue},\n  year = {1999}\n}\n";f.responses[bibURL]=modified.toByteArray()
  val jsonURL=f.address(PublishedCitationRepository.Format.JSON);f.responses[jsonURL]=(JSONObject(PublishedUtf8.decode(f.responses.getValue(jsonURL))).put("doi","10.0000/explicit-synthetic-fixture").put("venue","Explicit synthetic venue").put("publicationDate","1999-02-03").toString(2)+"\n").toByteArray()
  for(format in listOf(PublishedCitationRepository.Format.BIBTEX,PublishedCitationRepository.Format.JSON)){val original=f.repo.original(f.paper,article,format);assertArrayEquals(f.responses.getValue(f.address(format)),original.bytes);assertFalse(original.metadata().getBoolean("bundleHashVerified"))}
 }
 @Test fun lateAbaResponseCannotPublishAfterTheCallerGenerationChanged()=fixture("arxiv-micla"){f->coroutineScope{
  val article=f.bound();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();var generation=1
  val repo=PublishedCitationRepository(f.directory){url,_->entered.complete(Unit);release.await();f.responses.getValue(url)}
  val pending=async {runCatching{repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX,requireCurrent={check(generation==1){"Explicit synthetic reading ABA"}})}}
  entered.await();generation=2;generation=3;release.complete(Unit);assertTrue(pending.await().isFailure);assertTrue(f.artifactFiles().isEmpty())
 }}
 @Test fun actualCoroutineCancellationLeavesNoReadyOrPartiallyUsableCitation()=fixture("arxiv-micla"){f->coroutineScope{
  val article=f.bound();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();val repo=PublishedCitationRepository(f.directory){url,_->entered.complete(Unit);release.await();f.responses.getValue(url)}
  val pending=async{repo.original(f.paper,article,PublishedCitationRepository.Format.RIS)};entered.await();pending.cancelAndJoin();assertTrue(pending.isCancelled);assertTrue(f.artifactFiles().isEmpty())
 }}
 @Test fun artifactSymlinkAndReplacedResearchDirectoryPreserveOldBytesAndRejectAdoption()=fixture("arxiv-micla"){f->
  val article=f.bound();val original=f.repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX);val file=File(f.directory,"raw/${original.sha256}.bib");val retained=file.readBytes();file.delete();val outside=File(f.parent,"outside.bib").apply{writeBytes(retained)};Files.createSymbolicLink(file.toPath(),outside.toPath())
  assertTrue(runCatching{f.repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX,offline=true)}.isFailure);assertArrayEquals(retained,outside.readBytes());Files.delete(file.toPath());file.writeBytes(retained)
  val old=File(f.parent,"RetainedCitationOriginals");assertTrue(f.directory.renameTo(old));assertTrue(f.directory.mkdir());assertTrue(runCatching{f.repo.original(f.paper,article,PublishedCitationRepository.Format.BIBTEX,offline=true)}.isFailure);assertArrayEquals(retained,File(old,"raw/${original.sha256}.bib").readBytes())
 }

 @Test fun aCopiedFreshRevisionCannotBindDifferentUnhydratedHtml()=fixture("arxiv-micla"){f->
  val page=f.repo.fetchPage(f.paper);val actual=CatalogRepository.extractArticle(page.html,f.paper);val fake=actual.copy(html="<p>Explicit synthetic wrong body with copied revision</p>")
  val error=runCatching{f.repo.bindPage(f.paper,fake,page)}.exceptionOrNull();assertTrue(error is IllegalArgumentException);assertTrue(error!!.message!!.contains("逐字一致"));assertTrue(f.directory.walkTopDown().none{it.isFile})
 }
 @Test fun failedHttpBoundaryNeverAdoptsCacheFromAnotherReadingVersion()=fixture("arxiv-micla"){f->
  val article=f.bound();val before=canonical(article.json());val repo=PublishedCitationRepository(f.directory){_,_->throw java.io.IOException("Explicit synthetic404 or rejected redirect")}
  assertTrue(runCatching{repo.original(f.paper,article,PublishedCitationRepository.Format.JSON)}.exceptionOrNull() is java.io.IOException);assertEquals(before,canonical(article.json()));assertTrue(f.artifactFiles().isEmpty())
 }

 @Test fun anOrdinaryCopiedPageCannotMintTheInstancePrivateFetchWitness()=fixture("arxiv-micla"){f->
  val real=f.repo.fetchPage(f.paper);val article=CatalogRepository.extractArticle(real.html,f.paper);val forged=PublishedCitationRepository.PublishedPage(real.html,real.sourceURL)
  val error=runCatching{f.repo.bindPage(f.paper,article,forged)}.exceptionOrNull();assertTrue(error is AppFailure);assertTrue(error!!.message!!.contains("凭证已失效"));assertTrue(f.directory.walkTopDown().none{it.isFile});f.repo.releasePage(real)
 }
 @Test fun syntheticCredentialBearingSourceIdentityIsRejectedBeforeAnyFileRequest()=fixture("arxiv-micla"){f->
  val actual=CatalogRepository.extractArticle(PublishedUtf8.decode(f.responses.getValue(f.paper.blogURL)),f.paper);val address="https://fixture-user:fixture-password@arxiv.org/abs/2610.27491v1";val paper=f.paper.copy(sourceURL=address)
  val citation=actual.citation.copy().put("sourceUrl",address).put("absUrl",address);val article=actual.copy(sourceURL=address,citation=citation)
  val error=runCatching{f.repo.original(paper,article,PublishedCitationRepository.Format.BIBTEX)}.exceptionOrNull();assertTrue(error is IllegalArgumentException);assertTrue(error!!.message!!.contains("凭据"));assertTrue(f.calls.isEmpty());assertTrue(f.artifactFiles().isEmpty())
 }

}
