package com.nanless.paperdigest

import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.protocols.ClientProtocols
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

class DesktopDetailsRepositoryTest {
    private val site = CatalogRepository.SITE
    private val tinyPng: ByteArray = java.util.Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
    )

    private class MockSite {
        val routes = ConcurrentHashMap<String, Any>() // ByteArray, Int (HTTP status), or (String) -> ByteArray
        val requests = CopyOnWriteArrayList<String>()

        fun putBytes(relativeOrFull: String, bytes: ByteArray) {
            val full = if (relativeOrFull.startsWith("https://")) relativeOrFull else CatalogRepository.SITE + relativeOrFull
            routes[full] = bytes
        }

        fun putStatus(relativeOrFull: String, status: Int) {
            val full = if (relativeOrFull.startsWith("https://")) relativeOrFull else CatalogRepository.SITE + relativeOrFull
            routes[full] = status
        }

        fun putHandler(relativeOrFull: String, handler: (String) -> ByteArray) {
            val full = if (relativeOrFull.startsWith("https://")) relativeOrFull else CatalogRepository.SITE + relativeOrFull
            routes[full] = handler
        }

        @Suppress("UNCHECKED_CAST")
        fun fetch(url: String, limit: Int): ByteArray {
            requests += url
            val entry = routes[url] ?: throw PublishedHttpStatus(404)
            return when (entry) {
                is Int -> throw PublishedHttpStatus(entry)
                is ByteArray -> {
                    require(entry.size <= limit) { "Mock response exceeds limit $limit" }
                    entry.copyOf()
                }
                else -> (entry as (String) -> ByteArray).invoke(url).also { require(it.size <= limit) }
            }
        }
    }

    private data class BuiltDetail(
        val catalogRow: JSONObject,
        val detailBytes: ByteArray,
        val detailDescriptor: JSONObject,
        val articleBytes: ByteArray,
        val articleDescriptor: JSONObject,
        val sidecarFiles: Map<String, Pair<String, ByteArray>> = emptyMap(),
        val bundledAssets: Map<String, ByteArray> = emptyMap(),
    )

    private val tagRegistrySha = "9".repeat(64)

    private fun installTaxonomy(mock: MockSite): JSONObject {
        fun concept(id: String, facet: String, zh: String, parents: List<String> = emptyList()) = JSONObject()
            .put("id", id)
            .put("facet", facet)
            .put("zh", zh)
            .put("en", id)
            .put("ancestorIds", JSONArray(parents))
            .put("aliases", JSONArray())
            .put("status", "active")

        val snap = JSONObject()
            .put("contract", "paper-tag-catalog-snapshot-v2")
            .put("registryVersion", "paper-taxonomy-v2")
            .put("registrySha256", tagRegistrySha)
            .put("concepts", JSONArray()
                .put(concept("task.speech", "task", "语音任务"))
                .put(concept("task.asr", "task", "语音识别", listOf("task.speech")))
                .put(concept("method.llm", "method", "大语言模型"))
            )
        val ver = JSONObject()
            .put("contract", "paper-tag-catalog-versions-v2")
            .put("currentSha256", tagRegistrySha)
            .put("snapshots", JSONArray().put(snap))

        val snapBytes = snap.toString().toByteArray(Charsets.UTF_8)
        val verBytes = ver.toString().toByteArray(Charsets.UTF_8)
        mock.putBytes("data/tag-catalog-snapshot.json", snapBytes)
        mock.putBytes("data/tag-catalog-versions.json", verBytes)

        return JSONObject()
            .put("snapshot", JSONObject()
                .put("url", "data/tag-catalog-snapshot.json")
                .put("bytes", snapBytes.size)
                .put("sha256", sha256(snapBytes))
                .put("contract", "paper-tag-catalog-snapshot-v2")
                .put("schemaFingerprint", JSONObject.NULL)
                .put("registryVersion", "paper-taxonomy-v2")
                .put("registrySha256", tagRegistrySha)
            )
            .put("versions", JSONObject()
                .put("url", "data/tag-catalog-versions.json")
                .put("bytes", verBytes.size)
                .put("sha256", sha256(verBytes))
                .put("contract", "paper-tag-catalog-versions-v2")
                .put("schemaFingerprint", JSONObject.NULL)
                .put("currentSha256", tagRegistrySha)
            )
    }

    private fun buildPaperFixture(
        appearanceId: String,
        paperId: String?,
        identityStatus: String = "verified",
        sourceKind: String? = "arxiv",
        sourceVersionId: String? = "arxiv:2611.19844v1",
        originalTitle: String? = "Original English Scientific Title",
        readerTitle: String = "中文导读标题",
        blogPublishedAt: String = "2026-11-17",
        articleUpdatedAt: String? = null,
        publicationStatus: String = "active",
        retraction: JSONObject? = null,
        score: Double? = 7.4,
        authors: List<String> = listOf("Alice Researcher", "Bob Scientist"),
        sourceUrl: String? = "https://arxiv.org/abs/2611.19844v1",
        pdfUrl: String? = "https://arxiv.org/pdf/2611.19844v1.pdf",
        pdfSha256: String? = null,
        sourceVersionWarning: String? = null,
        provenanceDisclosure: String? = null,
        htmlFragment: String = "<div class=\"post-content\" id=\"article-body\"><h2>核心导读</h2><p>正文与公式 <math display=\"inline\"><mfrac><mi>x</mi><mn>2</mn></mfrac></math></p><table><thead><tr><th>System</th><th>WER</th></tr></thead><tbody><tr><td>Ours</td><td>4.2%</td></tr></tbody></table></div>",
        withSidecars: Boolean = false,
        abstractText: String? = if (withSidecars) "Verified original paper abstract from source." else null,
        resources: JSONArray = JSONArray(),
        bundledAssets: Map<String, ByteArray> = emptyMap(),
        tagConceptIds: List<String> = listOf("task.asr", "method.llm"),
    ): BuiltDetail {
        val artBytes = htmlFragment.toByteArray(Charsets.UTF_8)
        val artSha = sha256(artBytes)
        val artUrl = "client/details/articles/$artSha.html"
        val artDesc = JSONObject().put("url", artUrl).put("bytes", artBytes.size).put("sha256", artSha)
        val articleRevId = sha256("$appearanceId|$artSha|${sourceVersionId ?: ""}|$readerTitle".toByteArray(Charsets.UTF_8))

        val fullPageUrl = site + appearanceId
        val paperKey = paperId ?: "page:/audio-research-portal/$appearanceId"
        val arxivVer = if (sourceKind == "arxiv" && sourceVersionId != null && sourceVersionId.startsWith("arxiv:") && "@sha256:" !in sourceVersionId) {
            sourceVersionId.removePrefix("arxiv:")
        } else ""

        val citationRecord = ClientProtocols.record("paper-citation-source")
            .put("paperKey", paperKey)
            .put("paperId", paperId ?: "")
            .put("identityStatus", identityStatus)
            .put("verified", identityStatus == "verified")
            .put("complete", false)
            .put("sourceKind", sourceKind ?: "")
            .put("title", originalTitle ?: readerTitle)
            .put("authors", JSONArray(authors))
            .put("date", "")
            .put("doi", "")
            .put("venue", "")
            .put("arxivId", arxivVer)
            .put("url", sourceUrl ?: "")
            .put("sourceUrl", sourceUrl ?: "")
            .put("pdfUrl", pdfUrl ?: "")
            .put("pageUrl", fullPageUrl)
            .put("pageType", "paper")
        if (sourceVersionWarning != null) citationRecord.put("sourceVersionWarning", sourceVersionWarning)
        if (provenanceDisclosure != null) citationRecord.put("provenanceDisclosure", provenanceDisclosure)

        val sidecarMap = LinkedHashMap<String, Pair<String, ByteArray>>()
        val sidecarsObj = if (withSidecars && identityStatus == "verified" && sourceKind == "arxiv") {
            val baseNum = arxivVer.replace(Regex("v[1-9][0-9]*$"), "").replace('.', '-')
            val prefix = "client/papers/$blogPublishedAt/$baseNum"
            val citJson = ClientProtocols.record("researcher-sidecars")
                .put("id", arxivVer)
                .put("arxivId", arxivVer.replace(Regex("v[1-9][0-9]*$"), ""))
                .put("arxivVersionedId", arxivVer)
                .put("arxivVersion", 1)
                .put("type", "preprint")
                .put("title", originalTitle)
                .put("originalTitle", originalTitle)
                .put("authors", JSONArray(authors.map { JSONObject().put("name", it) }))
                .put("absUrl", sourceUrl)
                .put("pdfUrl", pdfUrl)
            val citJsonBytes = citJson.toString().toByteArray(Charsets.UTF_8)
            val bibBytes = "@misc{test2026,\n  title = {$originalTitle},\n  author = {${authors.joinToString(" and ")}},\n  year = {2026},\n  eprint = {$arxivVer},\n  archivePrefix = {arXiv},\n  url = {$sourceUrl}\n}".toByteArray(Charsets.UTF_8)
            val risBytes = "TY  - UNPB\nTI  - $originalTitle\nAU  - ${authors.first()}\nID  - $arxivVer\nUR  - $sourceUrl\nL1  - $pdfUrl\nER  - \n".toByteArray(Charsets.UTF_8)
            val ctxJson = ClientProtocols.record("paper-research-context")
                .put("readerTitle", readerTitle)
                .put("oneSentenceThesis", "一句话核心结论")
                .put("abstract", abstractText ?: JSONObject.NULL)
                .put("abstractSha256", abstractText?.let { sha256(it.toByteArray(Charsets.UTF_8)) } ?: JSONObject.NULL)
                .put("assessment", JSONObject().put("score", score ?: JSONObject.NULL))
            val ctxBytes = ctxJson.toString().toByteArray(Charsets.UTF_8)

            sidecarMap["citation.json"] = "$prefix/citation.json" to citJsonBytes
            sidecarMap["citation.bib"] = "$prefix/citation.bib" to bibBytes
            sidecarMap["citation.ris"] = "$prefix/citation.ris" to risBytes
            sidecarMap["rethink-context.json"] = "$prefix/rethink-context.json" to ctxBytes

            JSONObject().put("available", true).put("files", JSONObject()
                .put("citation.json", JSONObject()
                    .put("url", "$prefix/citation.json")
                    .put("bytes", citJsonBytes.size)
                    .put("sha256", sha256(citJsonBytes))
                    .put("contract", ClientProtocols.contract("researcher-sidecars"))
                    .put("schemaFingerprint", ClientProtocols.schemaFingerprint("researcher-sidecars")))
                .put("citation.bib", JSONObject()
                    .put("url", "$prefix/citation.bib")
                    .put("bytes", bibBytes.size)
                    .put("sha256", sha256(bibBytes)))
                .put("citation.ris", JSONObject()
                    .put("url", "$prefix/citation.ris")
                    .put("bytes", risBytes.size)
                    .put("sha256", sha256(risBytes)))
                .put("rethink-context.json", JSONObject()
                    .put("url", "$prefix/rethink-context.json")
                    .put("bytes", ctxBytes.size)
                    .put("sha256", sha256(ctxBytes))
                    .put("contract", ClientProtocols.contract("paper-research-context"))
                    .put("schemaFingerprint", ClientProtocols.schemaFingerprint("paper-research-context")))
            )
        } else {
            JSONObject().put("available", false).put("files", JSONObject()
                .put("citation.json", JSONObject.NULL)
                .put("citation.bib", JSONObject.NULL)
                .put("citation.ris", JSONObject.NULL)
                .put("rethink-context.json", JSONObject.NULL)
            )
        }

        val detailJson = ClientProtocols.record("paper-desktop-detail")
            .put("appearanceId", appearanceId)
            .put("paperId", paperId ?: JSONObject.NULL)
            .put("identityStatus", identityStatus)
            .put("sourceKind", sourceKind ?: JSONObject.NULL)
            .put("sourceVersion", JSONObject()
                .put("sourceVersionId", sourceVersionId ?: JSONObject.NULL)
                .put("paperId", paperId ?: JSONObject.NULL)
                .put("versionLabel", if (arxivVer.isNotEmpty()) "v1" else JSONObject.NULL)
                .put("sourceUrl", sourceUrl ?: JSONObject.NULL)
                .put("pdfUrl", pdfUrl ?: JSONObject.NULL)
                .put("pdfSha256", pdfSha256 ?: JSONObject.NULL)
                .put("pdfVersionBinding", JSONObject.NULL)
                .put("sourceVersionWarning", sourceVersionWarning ?: JSONObject.NULL)
                .put("provenanceDisclosure", provenanceDisclosure ?: JSONObject.NULL)
            )
            .put("appearance", JSONObject()
                .put("appearanceId", appearanceId)
                .put("pageUrl", appearanceId)
                .put("canonicalUrl", fullPageUrl)
                .put("pageType", "paper")
                .put("publicationStatus", publicationStatus)
                .put("retraction", retraction ?: JSONObject.NULL)
                .put("editionDate", blogPublishedAt)
                .put("categories", JSONArray(listOf("论文速递")))
                .put("summary", "目录摘要：$readerTitle")
                .put("articleRevisionId", articleRevId)
                .put("memberAppearanceIds", JSONArray())
                .put("memberPaperIds", JSONArray())
            )
            .put("articleRevision", JSONObject()
                .put("articleRevisionId", articleRevId)
                .put("appearanceId", appearanceId)
                .put("sourceVersionId", sourceVersionId ?: JSONObject.NULL)
                .put("articleDescriptor", artDesc)
                .put("sanitizerPolicy", "desktop-reader-html-fragment")
                .put("hasGuideContent", true)
                .put("resourceCount", resources.length())
                .put("guideResourcesBundled", false)
                .put("offlinePackageBundled", false)
            )
            .put("titles", JSONObject()
                .put("originalTitle", originalTitle ?: JSONObject.NULL)
                .put("readerTitle", readerTitle)
                .put("displayTitle", originalTitle ?: readerTitle)
            )
            .put("authors", JSONArray(authors.mapIndexed { idx, name ->
                JSONObject()
                    .put("position", idx + 1)
                    .put("name", name)
                    .put("givenName", JSONObject.NULL)
                    .put("familyName", JSONObject.NULL)
                    .put("orcid", JSONObject.NULL)
                    .put("affiliations", JSONArray())
                    .put("affiliationStatus", "unavailable")
                    .put("affiliationNote", "未绑定")
            }))
            .put("dates", JSONObject()
                .put("paperPublishedAt", JSONObject.NULL)
                .put("blogPublishedAt", blogPublishedAt)
                .put("articleUpdatedAt", articleUpdatedAt ?: JSONObject.NULL)
            )
            .put("bibliographic", JSONObject()
                .put("publicationType", if (sourceKind == "arxiv") "preprint" else if (sourceKind == "conference") "conference-paper" else JSONObject.NULL)
                .put("venue", JSONObject.NULL)
                .put("doi", JSONObject.NULL)
                .put("arxivId", if (arxivVer.isNotEmpty()) arxivVer.replace(Regex("v[1-9][0-9]*$"), "") else JSONObject.NULL)
                .put("arxivVersion", if (arxivVer.isNotEmpty()) 1 else JSONObject.NULL)
                .put("arxivVersionedId", if (arxivVer.isNotEmpty()) arxivVer else JSONObject.NULL)
                .put("volume", JSONObject.NULL)
                .put("issue", JSONObject.NULL)
                .put("pages", JSONObject.NULL)
                .put("language", JSONObject.NULL)
                .put("license", JSONObject.NULL)
                .put("sourceUrl", sourceUrl ?: JSONObject.NULL)
                .put("pdfUrl", pdfUrl ?: JSONObject.NULL)
            )
            .put("abstract", abstractText ?: JSONObject.NULL)
            .put("oneSentenceThesis", "一句话核心结论")
            .put("classification", JSONObject()
                .put("status", "verified")
                .put("publicationStatus", "published")
                .put("conceptIds", JSONArray(tagConceptIds))
                .put("concepts", JSONArray())
                .put("flatTags", JSONArray(listOf("语音识别", "大语言模型")))
                .put("primaryTaskId", "task.asr")
                .put("primaryTask", "语音识别")
                .put("primaryMethodId", "method.llm")
                .put("primaryMethod", "大语言模型")
                .put("researchType", JSONObject.NULL)
                .put("domainScope", JSONObject.NULL)
                .put("primaryResearchRole", JSONObject.NULL)
                .put("methodNotApplicable", JSONObject.NULL)
                .put("methodNotApplicableReason", JSONObject.NULL)
                .put("registryVersion", "paper-taxonomy-v2")
                .put("registrySha256", tagRegistrySha)
                .put("currentDisplayRegistrySha256", tagRegistrySha)
                .put("tagContract", ClientProtocols.contract("paper-tag-flat-tags"))
                .put("tagSchemaFingerprint", ClientProtocols.schemaFingerprint("paper-tag-flat-tags"))
                .put("classificationContract", JSONObject.NULL)
            )
            .put("assessment", JSONObject()
                .put("score", score ?: JSONObject.NULL)
                .put("scoreText", score?.toString() ?: JSONObject.NULL)
                .put("scale", "0-10")
                .put("rankBucket", "前50%")
                .put("documentType", "方法研究")
                .put("subscores", JSONObject.NULL)
                .put("rationale", JSONObject.NULL)
            )
            .put("citation", JSONObject()
                .put("verified", identityStatus == "verified")
                .put("complete", false)
                .put("missingFields", JSONArray(listOf("doi", "venue")))
                .put("fieldStatus", JSONObject())
                .put("sourceRecord", citationRecord)
            )
            .put("sidecars", sidecarsObj)
            .put("resources", resources)

        val detailBytes = detailJson.toString().toByteArray(Charsets.UTF_8)
        val detailSha = sha256(detailBytes)
        val detailUrl = "client/details/papers/$detailSha.json"
        val detailDesc = JSONObject().put("url", detailUrl).put("bytes", detailBytes.size).put("sha256", detailSha)

        val catalogRow = JSONObject()
            .put("appearanceId", appearanceId)
            .put("paperId", paperId ?: JSONObject.NULL)
            .put("identityStatus", identityStatus)
            .put("sourceKind", sourceKind ?: JSONObject.NULL)
            .put("sourceVersionId", sourceVersionId ?: JSONObject.NULL)
            .put("pageType", "paper")
            .put("publicationStatus", publicationStatus)
            .put("title", originalTitle ?: readerTitle)
            .put("titleZh", readerTitle)
            .put("summary", "目录摘要：$readerTitle")
            .put("blogPublishedAt", blogPublishedAt)
            .put("articleUpdatedAt", articleUpdatedAt ?: JSONObject.NULL)
            .put("pageUrl", appearanceId)
            .put("score", score ?: JSONObject.NULL)
            .put("tagConceptIds", JSONArray(tagConceptIds))
            .put("articleRevisionId", articleRevId)
            .put("detail", detailDesc)

        return BuiltDetail(catalogRow, detailBytes, detailDesc, artBytes, artDesc, sidecarMap, bundledAssets)
    }

    private fun buildAggregateRow(
        appearanceId: String,
        pageType: String,
        title: String,
        blogPublishedAt: String = "2026-11-17",
    ): JSONObject {
        val dummyDetailSha = sha256("agg|$appearanceId|$title".toByteArray(Charsets.UTF_8))
        val revSha = sha256("agg-rev|$appearanceId|$title".toByteArray(Charsets.UTF_8))
        return JSONObject()
            .put("appearanceId", appearanceId)
            .put("paperId", JSONObject.NULL)
            .put("identityStatus", "aggregate-page")
            .put("sourceKind", JSONObject.NULL)
            .put("sourceVersionId", JSONObject.NULL)
            .put("pageType", pageType)
            .put("publicationStatus", "active")
            .put("title", title)
            .put("titleZh", title)
            .put("summary", "汇总说明：$title")
            .put("blogPublishedAt", blogPublishedAt)
            .put("articleUpdatedAt", JSONObject.NULL)
            .put("pageUrl", appearanceId)
            .put("score", JSONObject.NULL)
            .put("tagConceptIds", JSONArray())
            .put("articleRevisionId", revSha)
            .put("detail", JSONObject()
                .put("url", "client/details/papers/$dummyDetailSha.json")
                .put("bytes", 256)
                .put("sha256", dummyDetailSha)
            )
    }

    private fun publishSnapshotToMock(
        mock: MockSite,
        items: List<BuiltDetail>,
        aggregateRows: List<JSONObject> = emptyList(),
        tombstones: List<JSONObject> = emptyList(),
        sourceCommit: String = "a".repeat(40),
        paperCountOverride: Int? = null,
    ): Pair<String, JSONObject> {
        val tagCatalogs = installTaxonomy(mock)
        items.forEach { item ->
            mock.putBytes(item.detailDescriptor.getString("url"), item.detailBytes)
            mock.putBytes(item.articleDescriptor.getString("url"), item.articleBytes)
            item.sidecarFiles.values.forEach { (url, bytes) -> mock.putBytes(url, bytes) }
            item.bundledAssets.forEach { (url, bytes) -> mock.putBytes(url, bytes) }
        }

        val allCatalogRows = ArrayList<JSONObject>()
        aggregateRows.forEach(allCatalogRows::add)
        items.forEach { allCatalogRows += it.catalogRow }

        val shardBytes = JSONArray(allCatalogRows).toString().toByteArray(Charsets.UTF_8)
        val shardSha = sha256(shardBytes)
        val shardUrl = "client/details/catalog/$shardSha.json"
        mock.putBytes(shardUrl, shardBytes)
        val shardDesc = JSONObject()
            .put("url", shardUrl)
            .put("bytes", shardBytes.size)
            .put("sha256", shardSha)
            .put("recordCount", allCatalogRows.size)

        val tombstoneShards = JSONArray()
        if (tombstones.isNotEmpty()) {
            val tBytes = JSONArray(tombstones).toString().toByteArray(Charsets.UTF_8)
            val tSha = sha256(tBytes)
            val tUrl = "client/details/tombstones/$tSha.json"
            mock.putBytes(tUrl, tBytes)
            tombstoneShards.put(JSONObject()
                .put("url", tUrl)
                .put("bytes", tBytes.size)
                .put("sha256", tSha)
                .put("recordCount", tombstones.size)
            )
        }

        val distinctPapers = HashSet<String>()
        items.forEach { item ->
            val r = item.catalogRow
            if (r.getString("identityStatus") == "verified") distinctPapers += r.getString("paperId")
            else distinctPapers += "unverified:${r.getString("appearanceId")}"
        }

        val snapshotObj = ClientProtocols.record("paper-desktop-snapshot")
            .put("sourceCommit", sourceCommit)
            .put("catalogShards", JSONArray().put(shardDesc))
            .put("recordCount", allCatalogRows.size)
            .put("appearanceCount", allCatalogRows.size)
            .put("paperCount", paperCountOverride ?: distinctPapers.size)
            .put("tombstoneShards", tombstoneShards)
            .put("tombstoneCount", tombstones.size)
            .put("tagCatalogs", tagCatalogs)
        val snapshotBytes = snapshotObj.toString().toByteArray(Charsets.UTF_8)
        val snapshotId = sha256(snapshotBytes)
        val snapshotUrl = "client/details/snapshots/$snapshotId.json"
        mock.putBytes(snapshotUrl, snapshotBytes)

        val manifestObj = ClientProtocols.record("paper-desktop-manifest")
            .put("snapshotId", snapshotId)
            .put("snapshot", JSONObject().put("url", snapshotUrl).put("bytes", snapshotBytes.size).put("sha256", snapshotId))
            .put("generatedAt", "2026-11-19T06:00:00+08:00")
            .put("sourceCommit", sourceCommit)
            .put("basePath", "/audio-research-portal/")
        val manifestBytes = manifestObj.toString().toByteArray(Charsets.UTF_8)
        mock.putBytes(DesktopDetailsRepository.MANIFEST_PATH, manifestBytes)
        return snapshotId to manifestObj
    }

    private inline fun withWorkspace(block: (File, PersonalStore) -> Unit) {
        val dir = Files.createTempDirectory("desktop-details-test-").toRealPath().toFile()
        try {
            block(dir, PersonalStore(dir))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun endToEndSyncExcludesAggregatesDeduplicatesMultiAppearancesAndSupportsColdReload() = runBlocking {
        withWorkspace { _, personal ->
            val mock = MockSite()
            val arxivEarly = buildPaperFixture(
                appearanceId = "posts/2026-11-15-speech-llm-2611-19844/",
                paperId = "arxiv:2611.19844",
                originalTitle = "Speech-LLM Enrollment-Free Target-Speaker ASR",
                readerTitle = "唤醒词引导目标说话人识别（初稿）",
                blogPublishedAt = "2026-11-15",
                score = 6.8,
                withSidecars = true,
            )
            val arxivLatest = buildPaperFixture(
                appearanceId = "posts/2026-11-17-speech-llm-2611-19844/",
                paperId = "arxiv:2611.19844",
                originalTitle = "Speech-LLM Enrollment-Free Target-Speaker ASR",
                readerTitle = "唤醒词引导目标说话人识别（修订稿）",
                blogPublishedAt = "2026-11-17",
                score = 7.2,
                sourceVersionWarning = "封存文本来自 v1；请注意核对官方历史版本。",
                withSidecars = true,
            )
            val confPaper = buildPaperFixture(
                appearanceId = "posts/conference-interspeech-2026-labrak26/",
                paperId = "conference:interspeech:2026:conference-paper-id:labrak26_interspeech",
                sourceKind = "conference",
                sourceVersionId = null,
                originalTitle = "Generating Synthetic Doctor-Patient Conversations",
                readerTitle = "医患长对话音频摘要合成基准",
                sourceUrl = "https://www.isca-archive.org/interspeech_2026/labrak26_interspeech.html",
                pdfUrl = "https://www.isca-archive.org/interspeech_2026/labrak26_interspeech.pdf",
                provenanceDisclosure = "历史本地封存来源；身份与 PDF 绑定已重放。",
            )
            val historicalUnverified = buildPaperFixture(
                appearanceId = "posts/2025-02-01-legacy-audio-note/",
                paperId = null,
                identityStatus = "historical-unverified",
                sourceKind = null,
                sourceVersionId = null,
                originalTitle = null,
                readerTitle = "早期未核验历史音频笔记",
                sourceUrl = null,
                pdfUrl = null,
                authors = emptyList(),
            )
            val dailyAgg = buildAggregateRow("posts/2026-11-17/", "daily", "2026-11-17 语音论文速递")
            val confAgg = buildAggregateRow("posts/interspeech2026-summary/", "conference", "Interspeech 2026 汇总")

            val (snapshotId, _) = publishSnapshotToMock(
                mock = mock,
                items = listOf(arxivEarly, arxivLatest, confPaper, historicalUnverified),
                aggregateRows = listOf(dailyAgg, confAgg),
            )

            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            val summary = repo.sync()

            // 6 total catalog rows (4 paper appearances + 2 aggregate pages), 3 distinct papers!
            assertEquals(snapshotId, summary.getString("snapshotID"))
            assertEquals(6, summary.getInt("recordCount"))
            assertEquals(3, summary.getInt("paperCount"))
            assertEquals("ready", summary.getString("websiteTaxonomyStatus"))
            assertTrue(repo.hasPublishedCatalogUpdate().not())

            // Initial sync must NEVER eagerly fetch papers/<sha>.json or articles/<sha>.html!
            assertFalse(mock.requests.any { it.contains("/client/details/papers/") || it.contains("/client/details/articles/") })

            val papers = repo.papers()
            assertEquals(3, papers.size)
            assertFalse("Aggregate pages must never become Paper objects", papers.any { it.title.contains("汇总") || it.title.contains("论文速递") })

            // Multi-appearance deduplication preserves both appearances and picks newer primary
            val dedupArxiv = papers.single { it.id == "arxiv:2611.19844" }
            assertEquals("唤醒词引导目标说话人识别（修订稿）", dedupArxiv.titleZh)
            assertEquals(
                listOf(
                    site + "posts/2026-11-15-speech-llm-2611-19844/",
                    site + "posts/2026-11-17-speech-llm-2611-19844/",
                ),
                dedupArxiv.appearances,
            )
            assertEquals(listOf("语音任务", "语音识别"), repo.websiteTaxonomy()!!.paths(dedupArxiv).first().map { it.label })

            // Historical unverified keeps page-scoped ID and null source/PDF URLs
            val unverified = papers.single { it.id.startsWith("page:") }
            assertEquals("historical-unverified", unverified.identityStatus)
            assertNull(unverified.pdfURL)

            // Aggregate catalog works natively from paper-desktop-snapshot without needing client/index.json!
            val aggCatalog = requireNotNull(repo.aggregateCatalog())
            assertEquals(snapshotId, aggCatalog.snapshotSHA256)
            assertEquals(2, aggCatalog.records.size)
            assertTrue(aggCatalog.records.any { it.kind == "daily" && it.title == "2026-11-17 语音论文速递" })
            assertTrue(aggCatalog.records.any { it.kind == "conference" && it.conferenceScope == "overview" })

            // PublishedRecordArchive verifies original desktop snapshot + catalog shards
            val archiveWitness = repo.publishedRecords(dedupArxiv)
            assertEquals("verified-local-originals", archiveWitness.getString("status"))
            assertEquals(2, archiveWitness.getJSONArray("records").length())

            // Cold reload from disk (`paperdigest-published-library` unchanged) makes zero HTTP calls
            val coldRepo = CatalogRepository(null, personal) { _, _ -> error("Cold reload must not use network") }
            assertEquals(3, coldRepo.papers().size)
            assertEquals(2, coldRepo.aggregateCatalog()!!.records.size)
        }
    }

    @Test
    fun onDemandDetailAndArticleReuseContentAddressedCachePreserveWarningsSidecarsAndHonestOffline() = runBlocking {
        withWorkspace { _, personal ->
            val mock = MockSite()
            val bundledPath = "images/papers/2611.19844/fig1-${sha256(tinyPng).take(16)}.png"
            val bundledRes = JSONArray().put(JSONObject()
                .put("resourceId", "res:bundled-fig1")
                .put("kind", "image")
                .put("mediaType", "image/png")
                .put("sourceUrl", "/audio-research-portal/$bundledPath")
                .put("availability", "bundled")
                .put("requiredForOffline", true)
                .put("descriptor", JSONObject()
                    .put("url", bundledPath)
                    .put("bytes", tinyPng.size)
                    .put("sha256", sha256(tinyPng)))
            )
            val arxivItem = buildPaperFixture(
                appearanceId = "posts/2026-11-17-speech-llm-2611-19844/",
                paperId = "arxiv:2611.19844",
                originalTitle = "Original English Title Distinct From Reader Title",
                readerTitle = "独立中文导读标题（不覆盖原题）",
                sourceVersionWarning = "特殊原文版本提示：当前使用 v1 封存稿",
                htmlFragment = "<div class=\"post-content\" id=\"article-body\"><h2>导读章节</h2><p>包含捆绑图：</p><img src=\"/audio-research-portal/$bundledPath\" alt=\"图1\"></div>",
                withSidecars = true,
                resources = bundledRes,
                bundledAssets = mapOf(bundledPath to tinyPng),
            )

            val externalImgUrl = "https://arxiv.org/html/2611.20001v1/unfetched.png"
            val externalRes = JSONArray().put(JSONObject()
                .put("resourceId", "res:ext-fig")
                .put("kind", "image")
                .put("mediaType", "image/png")
                .put("sourceUrl", externalImgUrl)
                .put("availability", "external")
                .put("requiredForOffline", true)
                .put("descriptor", JSONObject.NULL)
            )
            val externalImgItem = buildPaperFixture(
                appearanceId = "posts/2026-11-17-external-fig-2611-20001/",
                paperId = "arxiv:2611.20001",
                sourceVersionId = "arxiv:2611.20001v1",
                sourceUrl = "https://arxiv.org/abs/2611.20001v1",
                pdfUrl = "https://arxiv.org/pdf/2611.20001v1.pdf",
                provenanceDisclosure = "来源披露：外部图尚未内置打包",
                htmlFragment = "<div class=\"post-content\" id=\"article-body\"><p>外部图片段落</p><img src=\"$externalImgUrl\" alt=\"外链图\"></div>",
                resources = externalRes,
            )

            publishSnapshotToMock(mock, listOf(arxivItem, externalImgItem), sourceCommit = "1".repeat(40))
            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            repo.sync()

            // 1. Open paper with bundled image + sidecars -> completeOffline = true, originalTitle != readerTitle
            val p1 = repo.papers().single { it.id == "arxiv:2611.19844" }
            val article1 = repo.article(p1)
            val enrichedP1 = repo.papers().single { it.id == "arxiv:2611.19844" }
            assertEquals("Original English Title Distinct From Reader Title", enrichedP1.title)
            assertEquals("独立中文导读标题（不覆盖原题）", enrichedP1.titleZh)
            assertEquals(listOf("Alice Researcher", "Bob Scientist"), enrichedP1.authors)
            assertTrue(article1.completeOffline)
            assertTrue(article1.notices.any { it.contains("特殊原文版本提示") })
            assertEquals("Verified original paper abstract from source.", article1.researchContext!!.getString("abstract"))

            // Verify sidecar SHA-bound citation export (BibTeX, RIS, JSON)
            val bibOriginal = repo.citationOriginal(enrichedP1, article1, PublishedCitationRepository.Format.BIBTEX)
            assertTrue(String(bibOriginal.bytes, Charsets.UTF_8).contains("Original English Title Distinct From Reader Title"))
            val risOriginal = repo.citationOriginal(enrichedP1, article1, PublishedCitationRepository.Format.RIS)
            assertTrue(String(risOriginal.bytes, Charsets.UTF_8).contains("TY  - UNPB"))
            val jsonOriginal = repo.citationOriginal(enrichedP1, article1, PublishedCitationRepository.Format.JSON)
            assertTrue(String(jsonOriginal.bytes, Charsets.UTF_8).contains("2611.19844v1"))

            // 2. Open paper with unavailable external image -> readable body preserved, completeOffline MUST be false!
            val p2 = repo.papers().single { it.id == "arxiv:2611.20001" }
            val article2 = repo.article(p2)
            assertTrue(article2.html.contains("外部图片段落"))
            assertFalse("External uncached image must never claim completeOffline", article2.completeOffline)
            assertTrue(article2.notices.any { it.contains("来源披露：外部图尚未内置打包") })

            // 3. Publish Snapshot 2 (adding a third paper while keeping arxivItem's detail & article SHAs unchanged)
            val newPaper = buildPaperFixture(
                appearanceId = "posts/2026-11-18-new-paper-2611-30001/",
                paperId = "arxiv:2611.30001",
                sourceVersionId = "arxiv:2611.30001v1",
                sourceUrl = "https://arxiv.org/abs/2611.30001v1",
                pdfUrl = "https://arxiv.org/pdf/2611.30001v1.pdf",
            )
            publishSnapshotToMock(mock, listOf(arxivItem, externalImgItem, newPaper), sourceCommit = "2".repeat(40))
            assertTrue(repo.hasPublishedCatalogUpdate())
            repo.sync()
            assertEquals(3, repo.papers().size)

            // Clear request log and force refresh=true on arxiv:2611.19844 under Snapshot 2:
            // Content-addressed `papers/<sha>.json`, `articles/<sha>.html`, and bundled image MUST be reused from disk!
            mock.requests.clear()
            val refreshed = repo.article(repo.papers().single { it.id == "arxiv:2611.19844" }, refresh = true)
            assertTrue(refreshed.completeOffline)
            assertEquals("Zero network requests expected for unchanged content-addressed detail/article/asset", emptyList<String>(), mock.requests.toList())
        }
    }

    @Test
    fun dangerousHtmlInArticleFragmentIsRejectedFailClosed() = runBlocking {
        val badSvgAnimate = java.util.Base64.getEncoder().encodeToString(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><set attributeName=\"onload\" to=\"alert(1)\"/></svg>".toByteArray(Charsets.UTF_8)
        )
        val badSvgEntityScheme = java.util.Base64.getEncoder().encodeToString(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><a href=\"&#x6a;avascript:alert(1)\"><text>x</text></a></svg>".toByteArray(Charsets.UTF_8)
        )
        val tinyPngB64 = java.util.Base64.getEncoder().encodeToString(tinyPng)
        val dangerousPayloads = listOf(
            "<div id=\"article-body\"><p>正文</p><script>alert(1)</script></div>",
            "<div id=\"article-body\"><p onclick=\"steal()\">正文</p></div>",
            "<div id=\"article-body\"><iframe src=\"https://evil.example/\"></iframe></div>",
            "<div id=\"article-body\"><form action=\"https://evil.example/\"><input type=\"text\"></form></div>",
            "<div id=\"article-body\"><a href=\"javascript:alert(1)\">危险链接</a></div>",
            "<div id=\"article-body\"><a href=\"vbscript:msgbox(1)\">VBScript</a></div>",
            "<div id=\"article-body\"><a href=\"file:///etc/passwd\">本地文件</a></div>",
            "<div id=\"article-body\"><a href=\"zotero://select/items/1\">Zotero URI</a></div>",
            "<div id=\"article-body\"><a href=\"smb://evil.example/share\">SMB</a></div>",
            "<div id=\"article-body\"><a href=\"//evil.example/phish\">协议相对链接</a></div>",
            "<div id=\"article-body\"><img src=\"\\\\evil.example\\unc.png\"></div>",
            "<div id=\"article-body\"><a href=\"data:image/png;base64,$tinyPngB64\">Data href on link</a></div>",
            "<div id=\"article-body\"><img src=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\"></div>",
            "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,$badSvgAnimate\"></div>",
            "<div id=\"article-body\"><img src=\"data:image/svg+xml;base64,$badSvgEntityScheme\"></div>",
            "<div id=\"article-body\"><img src=\"https://arxiv.org/html/2611.19844v1/ok.png\" srcset=\"https://arxiv.org/html/2611.19844v1/ok.png 1x, javascript:alert(1) 2x\"></div>",
            "<div id=\"article-body\"><img src=\"https://arxiv.org/html/2611.19844v1/ok.png\" srcset=\"file:///etc/passwd 1x\"></div>",
            "<div id=\"article-body\"><p>内联SVG禁止</p><svg width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\"/></svg></div>",
            "<div id=\"article-body\"><xmp>RAWTEXT xmp</xmp></div>",
            "<div id=\"article-body\"><noscript><p>noscript</p></noscript></div>",
            "<div id=\"article-body\"><!-- HTML comment forbidden --><p>正文</p></div>",
        )
        for ((idx, badHtml) in dangerousPayloads.withIndex()) {
            withWorkspace { _, personal ->
                val mock = MockSite()
                val badItem = buildPaperFixture(
                    appearanceId = "posts/2026-11-17-bad-html-$idx-2611-19844/",
                    paperId = "arxiv:2611.19844",
                    htmlFragment = badHtml,
                )
                publishSnapshotToMock(mock, listOf(badItem))
                val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
                repo.sync()
                val paper = repo.papers().single()
                val result = runCatching { repo.article(paper) }
                assertTrue("Dangerous HTML case #$idx must fail closed: $badHtml", result.isFailure)
            }
        }
    }

    @Test
    fun failClosedPreservesPreviousValidCatalogOnTamperInvalidSchemaMissingShardOr500While404FallsBackCleanly() = runBlocking {
        // Part A: Clean fallback ONLY when client/details/manifest.json returns HTTP 404
        withWorkspace { _, personal ->
            val mock = MockSite()
            mock.putStatus(DesktopDetailsRepository.MANIFEST_PATH, 404)
            mock.putStatus("client/index.json", 404)
            val legacyRow = JSONObject()
                .put("pageType", "paper")
                .put("title", "Legacy Fallback Paper")
                .put("identityStatus", "verified")
                .put("sourceKind", "arxiv")
                .put("arxivId", "2601.00001v1")
                .put("permalink", "posts/legacy-fallback/")
                .put("citation", JSONObject()
                    .put("title", "Legacy Fallback Paper")
                    .put("arxivId", "2601.00001v1")
                    .put("sourceUrl", "https://arxiv.org/abs/2601.00001v1")
                    .put("pdfUrl", "https://arxiv.org/pdf/2601.00001v1.pdf"))
            mock.putBytes("index.json", JSONArray().put(legacyRow).toString().toByteArray(Charsets.UTF_8))

            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            repo.sync()
            assertEquals(1, repo.papers().size)
            assertEquals("arxiv:2601.00001", repo.papers().single().id)
        }

        // Part B: Once valid catalog is synced, every protocol/SHA/500/cross-snapshot failure preserves previous catalog!
        withWorkspace { dir, personal ->
            val mock = MockSite()
            val validItem = buildPaperFixture(
                appearanceId = "posts/2026-11-17-baseline-2611-19844/",
                paperId = "arxiv:2611.19844",
                originalTitle = "Baseline Trusted Paper",
            )
            val (baselineSnapshotId, baselineManifest) = publishSnapshotToMock(mock, listOf(validItem), sourceCommit = "a".repeat(40))
            // Also plant a valid legacy index.json to prove HTTP 500 / invalid manifest NEVER silently falls back to it!
            mock.putBytes("index.json", JSONArray().toString().toByteArray(Charsets.UTF_8))

            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            repo.sync()
            val currentFile = File(dir, "PublishedLibrary/current.json")
            val baselineBytes = currentFile.readBytes()
            val baselineEpoch = repo.epoch()

            fun assertBaselineIntact(label: String) {
                assertEquals(label, baselineSnapshotId, repo.summary().getString("snapshotID"))
                assertEquals(label, baselineEpoch, repo.epoch())
                assertEquals(label, listOf("arxiv:2611.19844"), repo.papers().map { it.id })
                assertArrayEquals(label, baselineBytes, currentFile.readBytes())
            }

            // 1. HTTP 500 on client/details/manifest.json -> NO fallback!
            mock.putStatus(DesktopDetailsRepository.MANIFEST_PATH, 500)
            assertTrue(runCatching { repo.sync() }.isFailure)
            assertBaselineIntact("HTTP 500 must not fall back")

            // 2. Unknown schemaFingerprint on manifest
            val badFpManifest = baselineManifest.copy().put("schemaFingerprint", "f".repeat(64))
            mock.putBytes(DesktopDetailsRepository.MANIFEST_PATH, badFpManifest.toString().toByteArray(Charsets.UTF_8))
            assertTrue(runCatching { repo.sync() }.isFailure)
            assertBaselineIntact("Unknown schemaFingerprint must fail closed")

            // 3. Duplicate key in manifest JSON
            val validManifestStr = baselineManifest.toString()
            val dupKeyBytes = (validManifestStr.dropLast(1) + ",\"basePath\":\"/audio-research-portal/\"}").toByteArray(Charsets.UTF_8)
            mock.putBytes(DesktopDetailsRepository.MANIFEST_PATH, dupKeyBytes)
            assertTrue(runCatching { repo.sync() }.isFailure)
            assertBaselineIntact("Duplicate JSON key must fail closed")

            // 4. 1-byte SHA tamper on snapshot bytes
            val nextItem = buildPaperFixture(
                appearanceId = "posts/2026-11-18-tampered-2611-22222/",
                paperId = "arxiv:2611.22222",
                sourceVersionId = "arxiv:2611.22222v1",
                sourceUrl = "https://arxiv.org/abs/2611.22222v1",
                pdfUrl = "https://arxiv.org/pdf/2611.22222v1.pdf",
            )
            val (_, nextManifest) = publishSnapshotToMock(mock, listOf(validItem, nextItem), sourceCommit = "b".repeat(40))
            val snapUrl = nextManifest.getJSONObject("snapshot").getString("url")
            val origSnapBytes = (mock.routes[site + snapUrl] as ByteArray).copyOf()
            val tamperedSnap = origSnapBytes.copyOf().also { it[it.size - 2] = if (it[it.size - 2] == ' '.code.toByte()) '\n'.code.toByte() else ' '.code.toByte() }
            mock.putBytes(snapUrl, tamperedSnap)
            assertTrue(runCatching { repo.sync() }.isFailure)
            assertBaselineIntact("1-byte snapshot SHA tamper must fail closed")

            // 5. Missing catalog shard (HTTP 404)
            publishSnapshotToMock(mock, listOf(validItem, nextItem), sourceCommit = "c".repeat(40))
            val snapForMissing = JSONObject(String(mock.routes[site + JSONObject(String(mock.routes[site + DesktopDetailsRepository.MANIFEST_PATH] as ByteArray)).getJSONObject("snapshot").getString("url")] as ByteArray))
            val missingShardUrl = snapForMissing.getJSONArray("catalogShards").getJSONObject(0).getString("url")
            mock.putStatus(missingShardUrl, 404)
            assertTrue(runCatching { repo.sync() }.isFailure)
            assertBaselineIntact("Missing catalog shard must fail closed")

            // 6. Cross-snapshot sourceCommit mismatch between manifest and snapshot
            val (_, commitManifest) = publishSnapshotToMock(mock, listOf(validItem, nextItem), sourceCommit = "d".repeat(40))
            val mismatchedManifest = commitManifest.copy().put("sourceCommit", "e".repeat(40))
            mock.putBytes(DesktopDetailsRepository.MANIFEST_PATH, mismatchedManifest.toString().toByteArray(Charsets.UTF_8))
            assertTrue(runCatching { repo.sync() }.isFailure)
            assertBaselineIntact("Cross-snapshot sourceCommit mismatch must fail closed")

            // 7. On-demand detail 1-byte SHA tamper must fail closed before JSON parse
            publishSnapshotToMock(mock, listOf(validItem), sourceCommit = "a".repeat(40))
            val detailUrl = validItem.detailDescriptor.getString("url")
            val tamperedDetail = validItem.detailBytes.copyOf().also { it[0] = ' '.code.toByte() }
            mock.putBytes(detailUrl, tamperedDetail)
            assertTrue(runCatching { repo.article(repo.papers().single(), refresh = true) }.isFailure)
        }
    }

    @Test
    fun tombstonesAndRestorationPreservePersonalNotesAnnotationsReadingStateAndSessions() = runBlocking {
        withWorkspace { _, personal ->
            val mock = MockSite()
            val pRemoved = buildPaperFixture(
                appearanceId = "posts/2026-11-10-removed-2611-10001/",
                paperId = "arxiv:2611.10001",
                sourceVersionId = "arxiv:2611.10001v1",
                sourceUrl = "https://arxiv.org/abs/2611.10001v1",
                pdfUrl = "https://arxiv.org/pdf/2611.10001v1.pdf",
                readerTitle = "稍后被站点下架的论文",
            )
            val pRetracted = buildPaperFixture(
                appearanceId = "posts/2026-11-11-retracted-2611-10002/",
                paperId = "arxiv:2611.10002",
                sourceVersionId = "arxiv:2611.10002v1",
                sourceUrl = "https://arxiv.org/abs/2611.10002v1",
                pdfUrl = "https://arxiv.org/pdf/2611.10002v1.pdf",
                readerTitle = "稍后正式撤稿并移除页面的论文",
            )
            val pReplacedOld = buildPaperFixture(
                appearanceId = "posts/2026-11-12-old-slug-2611-10003/",
                paperId = "arxiv:2611.10003",
                sourceVersionId = "arxiv:2611.10003v1",
                sourceUrl = "https://arxiv.org/abs/2611.10003v1",
                pdfUrl = "https://arxiv.org/pdf/2611.10003v1.pdf",
                readerTitle = "旧路径导读",
            )

            // Snapshot 1: all 3 papers active
            publishSnapshotToMock(mock, listOf(pRemoved, pRetracted, pReplacedOld), sourceCommit = "1".repeat(40))
            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            repo.sync()
            assertEquals(3, repo.papers().size)

            // Create personal notes, annotations, readingState, favorites, and study sessions for these papers
            personal.saveNote("arxiv:2611.10001", "私人研究笔记：保留不删", 0)
            personal.saveNote("arxiv:2611.10002", "撤稿论文的个人复盘笔记", 0)
            personal.saveAnnotation("arxiv:2611.10001", JSONObject().put("id", "ann-1").put("quote", "关键公式标注"))
            personal.saveReading("arxiv:2611.10001", JSONObject().put("scrollRatio", 0.72))
            personal.toggleList("favorites", "arxiv:2611.10001")
            personal.appendSession(JSONObject()
                .put("id", "study-session-1")
                .put("paperID", "arxiv:2611.10001")
                .put("question", "方法假设是什么？")
                .put("answer", "已保存的付费模型回答")
                .put("status", "completed"))

            // Negative check: Tombstone intersecting active catalog MUST fail closed!
            val conflictingTomb = JSONObject()
                .put("appearanceId", pRemoved.catalogRow.getString("appearanceId"))
                .put("paperId", "arxiv:2611.10001")
                .put("previousArticleRevisionId", pRemoved.catalogRow.getString("articleRevisionId"))
                .put("reason", "site-removed")
                .put("effectiveAt", "2026-11-18T10:00:00Z")
                .put("sourceCommit", "2".repeat(40))
                .put("replacementAppearanceId", JSONObject.NULL)
                .put("evidenceUrl", JSONObject.NULL)
                .put("note", JSONObject.NULL)
            publishSnapshotToMock(mock, listOf(pRemoved, pRetracted, pReplacedOld), tombstones = listOf(conflictingTomb), sourceCommit = "2".repeat(40))
            assertTrue("Tombstone intersecting active appearanceId must fail closed", runCatching { repo.sync() }.isFailure)

            // Negative check: `retracted` tombstone without HTTPS evidenceUrl MUST fail closed!
            val badRetractedTomb = JSONObject()
                .put("appearanceId", pRetracted.catalogRow.getString("appearanceId"))
                .put("paperId", "arxiv:2611.10002")
                .put("previousArticleRevisionId", pRetracted.catalogRow.getString("articleRevisionId"))
                .put("reason", "retracted")
                .put("effectiveAt", "2026-11-18T10:00:00Z")
                .put("sourceCommit", "2".repeat(40))
                .put("replacementAppearanceId", JSONObject.NULL)
                .put("evidenceUrl", JSONObject.NULL)
                .put("note", "缺少证据链接")
            publishSnapshotToMock(mock, listOf(pRemoved, pReplacedOld), tombstones = listOf(badRetractedTomb), sourceCommit = "2".repeat(40))
            assertTrue("Retracted tombstone without HTTPS evidenceUrl must fail closed", runCatching { repo.sync() }.isFailure)

            // Snapshot 2: valid `site-removed` + `retracted` (with HTTPS evidenceUrl) + `replaced` (pointing to new active appearance)
            val pReplacedNew = buildPaperFixture(
                appearanceId = "posts/2026-11-18-canonical-slug-2611-10003/",
                paperId = "arxiv:2611.10003",
                sourceVersionId = "arxiv:2611.10003v1",
                sourceUrl = "https://arxiv.org/abs/2611.10003v1",
                pdfUrl = "https://arxiv.org/pdf/2611.10003v1.pdf",
                readerTitle = "规范新路径导读",
                blogPublishedAt = "2026-11-18",
            )
            val validSiteRemoved = conflictingTomb.copy()
            val validRetracted = badRetractedTomb.copy()
                .put("evidenceUrl", "https://arxiv.org/abs/2611.10002v2")
                .put("note", "作者已在官方页面发布撤稿声明")
            val validReplaced = JSONObject()
                .put("appearanceId", pReplacedOld.catalogRow.getString("appearanceId"))
                .put("paperId", "arxiv:2611.10003")
                .put("previousArticleRevisionId", pReplacedOld.catalogRow.getString("articleRevisionId"))
                .put("reason", "replaced")
                .put("effectiveAt", "2026-11-18T10:00:00Z")
                .put("sourceCommit", "3".repeat(40))
                .put("replacementAppearanceId", pReplacedNew.catalogRow.getString("appearanceId"))
                .put("evidenceUrl", JSONObject.NULL)
                .put("note", "迁移至规范路径")

            publishSnapshotToMock(
                mock = mock,
                items = listOf(pReplacedNew),
                tombstones = listOf(validSiteRemoved, validRetracted, validReplaced),
                sourceCommit = "3".repeat(40),
            )
            val summary2 = repo.sync()
            assertEquals(1, summary2.getInt("paperCount"))
            assertEquals(3, summary2.getInt("tombstoneCount"))
            val missingIds = summary2.getJSONArray("missingFromLatest").strings().toSet()
            assertEquals(setOf("arxiv:2611.10001", "arxiv:2611.10002"), missingIds)

            // Retired papers remain accessible in repo.papers() and personal data is 100% untouched!
            assertEquals(3, repo.papers().size)
            assertEquals("私人研究笔记：保留不删", personal.note("arxiv:2611.10001").getString("text"))
            assertEquals("撤稿论文的个人复盘笔记", personal.note("arxiv:2611.10002").getString("text"))
            assertEquals(1, personal.annotations("arxiv:2611.10001").size)
            assertEquals(0.72, personal.snapshot().getJSONObject("readingState").getJSONObject("arxiv:2611.10001").getDouble("scrollRatio"), 0.0001)
            assertEquals(listOf("arxiv:2611.10001"), personal.list("favorites"))
            assertEquals("已保存的付费模型回答", personal.session("study-session-1")!!.getString("answer"))

            val historyAfterRemoval = repo.tombstoneHistory()
            assertEquals(3, historyAfterRemoval.getJSONObject("currentTombstones").length())
            assertEquals(3, historyAfterRemoval.getJSONArray("events").length())

            // Snapshot 3: Restore `pRemoved` (re-enters active catalogShards and exits tombstoneShards!)
            publishSnapshotToMock(
                mock = mock,
                items = listOf(pRemoved, pReplacedNew),
                tombstones = listOf(validRetracted, validReplaced),
                sourceCommit = "4".repeat(40),
            )
            val summary3 = repo.sync()
            assertEquals(2, summary3.getInt("paperCount"))
            assertEquals(2, summary3.getInt("tombstoneCount"))
            assertEquals(listOf("arxiv:2611.10002"), summary3.getJSONArray("missingFromLatest").strings())

            // Old tombstone never re-hides restored paper; both removal and restoration events are preserved!
            val historyAfterRestore = repo.tombstoneHistory()
            assertFalse(historyAfterRestore.getJSONObject("currentTombstones").has(pRemoved.catalogRow.getString("appearanceId")))
            val eventTypes = historyAfterRestore.getJSONArray("events").objects().map { it.getString("eventType") }
            assertEquals(3, eventTypes.count { it == "tombstone" })
            assertEquals(1, eventTypes.count { it == "restored" })
            assertEquals("私人研究笔记：保留不删", personal.note("arxiv:2611.10001").getString("text"))
        }
    }

    @Test
    fun midReadEpochRotationCrossPaperDetailMixAndMissingImageAreEnforcedStrictly() = runBlocking {
        withWorkspace { _, personal ->
            val mock = MockSite()
            val missingImgRes = JSONArray().put(JSONObject()
                .put("resourceId", "res:missing-1")
                .put("kind", "image")
                .put("mediaType", "image/png")
                .put("sourceUrl", "icassp-img://paperA/missing.png")
                .put("availability", "missing")
                .put("requiredForOffline", true)
                .put("descriptor", JSONObject.NULL)
            )
            val paperA = buildPaperFixture(
                appearanceId = "posts/2026-11-17-paper-a-2611-40001/",
                paperId = "arxiv:2611.40001",
                sourceVersionId = "arxiv:2611.40001v1",
                sourceUrl = "https://arxiv.org/abs/2611.40001v1",
                pdfUrl = "https://arxiv.org/pdf/2611.40001v1.pdf",
                resources = missingImgRes,
            )
            val paperB = buildPaperFixture(
                appearanceId = "posts/2026-11-17-paper-b-2611-40002/",
                paperId = "arxiv:2611.40002",
                sourceVersionId = "arxiv:2611.40002v1",
                sourceUrl = "https://arxiv.org/abs/2611.40002v1",
                pdfUrl = "https://arxiv.org/pdf/2611.40002v1.pdf",
            )
            publishSnapshotToMock(mock, listOf(paperA, paperB), sourceCommit = "a".repeat(40))
            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            repo.sync()

            // 1. `missing` image resource -> completeOffline MUST be false!
            val loadedMissing = repo.article(repo.papers().single { it.id == "arxiv:2611.40001" })
            assertFalse("Missing image resource must keep completeOffline=false", loadedMissing.completeOffline)

            // 2a. Cross-paper detail mix when paperA's detail is ALREADY cached on disk -> rejected immediately during sync()!
            val mixedCachedRowB = paperB.catalogRow.copy().put("detail", paperA.detailDescriptor.copy())
            val mixedCachedItemB = paperB.copy(catalogRow = mixedCachedRowB)
            publishSnapshotToMock(mock, listOf(paperA, mixedCachedItemB), sourceCommit = "b".repeat(40))
            assertTrue(
                "Cross-paper detail descriptor mix against cached detail must fail closed during sync",
                runCatching { repo.sync() }.isFailure,
            )

            // 2b. Cross-paper detail mix when uncached paperD's detail is pointed to by paperB -> rejected fail-closed on article()!
            val paperD = buildPaperFixture(
                appearanceId = "posts/2026-11-17-paper-d-2611-40004/",
                paperId = "arxiv:2611.40004",
                sourceVersionId = "arxiv:2611.40004v1",
                sourceUrl = "https://arxiv.org/abs/2611.40004v1",
                pdfUrl = "https://arxiv.org/pdf/2611.40004v1.pdf",
            )
            mock.putBytes(paperD.detailDescriptor.getString("url"), paperD.detailBytes)
            val mixedUncachedRowB = paperB.catalogRow.copy().put("detail", paperD.detailDescriptor.copy())
            val mixedUncachedItemB = paperB.copy(catalogRow = mixedUncachedRowB)
            publishSnapshotToMock(mock, listOf(paperA, mixedUncachedItemB), sourceCommit = "e".repeat(40))
            repo.sync()
            assertTrue(
                "Cross-paper detail descriptor mix against uncached detail must fail closed on article()",
                runCatching { repo.article(repo.papers().single { it.id == "arxiv:2611.40002" }, refresh = true) }.isFailure,
            )

            // 3. Mid-read snapshot.epoch rotation must reject adopting stale read into rotated snapshot!
            val paperC = buildPaperFixture(
                appearanceId = "posts/2026-11-17-paper-c-2611-40003/",
                paperId = "arxiv:2611.40003",
                sourceVersionId = "arxiv:2611.40003v1",
                sourceUrl = "https://arxiv.org/abs/2611.40003v1",
                pdfUrl = "https://arxiv.org/pdf/2611.40003v1.pdf",
                htmlFragment = "<div class=\"post-content\" id=\"article-body\"><p>Unique paperC body for mid-read epoch rotation test</p></div>",
            )
            publishSnapshotToMock(mock, listOf(paperC), sourceCommit = "c".repeat(40))
            repo.sync()
            val pC = repo.papers().single { it.id == "arxiv:2611.40003" }
            val artUrl = paperC.articleDescriptor.getString("url")
            val artBytes = paperC.articleBytes
            mock.putHandler(artUrl) {
                // Rotate snapshot epoch mid-read before article bytes return!
                runBlocking {
                    publishSnapshotToMock(mock, listOf(paperA, paperC), sourceCommit = "d".repeat(40))
                    repo.sync()
                }
                artBytes
            }
            assertTrue(
                "Mid-read snapshot.epoch rotation must fail closed",
                runCatching { repo.article(pC, refresh = true) }.isFailure,
            )
        }
    }

    @Test
    fun atomicCommitPointPreservesPreviousStateOnCrashAndCorruptStateFailsClosed() = runBlocking {
        withWorkspace { dir, personal ->
            val mock = MockSite()
            val paperS1 = buildPaperFixture(
                appearanceId = "posts/2026-11-17-s1-paper-2611-50001/",
                paperId = "arxiv:2611.50001",
                sourceVersionId = "arxiv:2611.50001v1",
                sourceUrl = "https://arxiv.org/abs/2611.50001v1",
                pdfUrl = "https://arxiv.org/pdf/2611.50001v1.pdf",
            )
            val tombS1 = JSONObject()
                .put("appearanceId", "posts/2026-11-10-old-removed-2611-59999/")
                .put("paperId", "arxiv:2611.59999")
                .put("previousArticleRevisionId", "a".repeat(64))
                .put("reason", "site-removed")
                .put("effectiveAt", "2026-11-17T08:00:00Z")
                .put("sourceCommit", "1".repeat(40))
                .put("replacementAppearanceId", JSONObject.NULL)
                .put("evidenceUrl", JSONObject.NULL)
                .put("note", JSONObject.NULL)
            val (s1Id, _) = publishSnapshotToMock(mock, listOf(paperS1), tombstones = listOf(tombS1), sourceCommit = "1".repeat(40))

            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            repo.sync()
            val s1Epoch = repo.epoch()
            val s1CurrentBytes = File(dir, "PublishedLibrary/current.json").readBytes()
            assertEquals(1, repo.tombstoneHistory().getJSONObject("currentTombstones").length())

            // Simulate crash/cancellation AFTER prepareStateFiles() runs and BEFORE current.json atomic move!
            val paperS2 = buildPaperFixture(
                appearanceId = "posts/2026-11-18-s2-paper-2611-50002/",
                paperId = "arxiv:2611.50002",
                sourceVersionId = "arxiv:2611.50002v1",
                sourceUrl = "https://arxiv.org/abs/2611.50002v1",
                pdfUrl = "https://arxiv.org/pdf/2611.50002v1.pdf",
            )
            val (s2Id, _) = publishSnapshotToMock(mock, listOf(paperS2), tombstones = emptyList(), sourceCommit = "2".repeat(40))
            repo.beforeCurrentCatalogWriteHook = {
                throw IllegalStateException("Simulated crash after prepareStateFiles before current.json move")
            }
            assertTrue(runCatching { repo.sync() }.isFailure)
            repo.beforeCurrentCatalogWriteHook = null

            // S1 state, current.json, and tombstoneHistory MUST remain 100% intact both in-memory and across cold reload!
            assertEquals(s1Id, repo.summary().getString("snapshotID"))
            assertEquals(s1Epoch, repo.epoch())
            assertArrayEquals(s1CurrentBytes, File(dir, "PublishedLibrary/current.json").readBytes())
            assertEquals(1, repo.tombstoneHistory().getJSONObject("currentTombstones").length())
            val statesDir = File(dir, "PublishedLibrary/desktop-details/states")
            assertFalse("Uncommitted S2 state file must be rolled back", statesDir.listFiles().orEmpty().any { it.name.startsWith(s2Id) })

            val coldAfterCrash = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            assertEquals(s1Id, coldAfterCrash.summary().getString("snapshotID"))
            assertEquals(s1Epoch, coldAfterCrash.epoch())
            assertEquals(1, coldAfterCrash.tombstoneHistory().getJSONObject("currentTombstones").length())
            val s1Article = coldAfterCrash.article(coldAfterCrash.papers().single())
            assertTrue(s1Article.html.contains("核心导读"))

            // Corrupting the active epoch-bound state file MUST fail closed on reload (never fall back to legacy scraping!)
            val activeStateFile = File(statesDir, "$s1Id-$s1Epoch.json")
            assertTrue(activeStateFile.isFile)
            activeStateFile.writeText("{\"corrupt\":true}", Charsets.UTF_8)
            assertTrue(
                "Corrupt MANIFEST_CONTRACT state file must fail closed on cold CatalogRepository load",
                runCatching { CatalogRepository(null, personal) { _, _ -> error("No network") } }.isFailure,
            )

            // Also verify article() for an unbound paper on a MANIFEST_CONTRACT catalog fails closed instead of HTML scraping!
            val unboundPaper = Paper(
                id = "arxiv:2699.99999",
                title = "Unbound Paper",
                titleZh = "未绑定论文",
                date = "2026-11-19",
                blogURL = site + "posts/2026-11-19-unbound/",
                sourceKind = "arxiv",
                identityStatus = "verified",
                sourceVersion = "2699.99999v1",
                sourceURL = "https://arxiv.org/abs/2699.99999v1",
                pdfURL = "https://arxiv.org/pdf/2699.99999v1.pdf",
                citation = JSONObject(),
                appearances = listOf(site + "posts/2026-11-19-unbound/"),
            )
            mock.putBytes("posts/2026-11-19-unbound/", "<div id=\"article-body\" class=\"post-content\"><p>Should never scrape!</p></div>".toByteArray())
            assertTrue(
                "MANIFEST_CONTRACT catalog must never fall back to legacy HTML scraping",
                runCatching { repo.article(unboundPaper) }.isFailure,
            )
        }
    }

    @Test
    fun offlineStoreRegisterOpenAndEarlyPaperEnrichmentBeforeOnReadable() = runBlocking {
        val samplePdfBytes: ByteArray = run {
            val vectors = javaClass.classLoader!!.getResourceAsStream("offline-swift-vectors.json")!!.use {
                JSONObject(it.readBytes().toString(Charsets.UTF_8))
            }
            val packetWithPdf = vectors.getJSONArray("packets").objects().first { it.optBoolean("hasPDF") }
            val pdfEntry = packetWithPdf.getJSONArray("files").objects().first { it.getString("path") == "original.pdf" }
            java.util.Base64.getDecoder().decode(pdfEntry.getString("data"))
        }

        withWorkspace { dir, personal ->
            val mock = MockSite()
            val bundledPath = "images/papers/2611.60001/fig1-${sha256(tinyPng).take(16)}.png"
            val pdfUrl = "https://arxiv.org/pdf/2611.60001v1.pdf"
            val expectedPdfSha = sha256(samplePdfBytes)
            mock.putBytes(pdfUrl, samplePdfBytes)

            val resources = JSONArray()
                .put(JSONObject()
                    .put("resourceId", "res:bundled-fig1")
                    .put("kind", "image")
                    .put("mediaType", "image/png")
                    .put("sourceUrl", "/audio-research-portal/$bundledPath")
                    .put("availability", "bundled")
                    .put("requiredForOffline", true)
                    .put("descriptor", JSONObject()
                        .put("url", bundledPath)
                        .put("bytes", tinyPng.size)
                        .put("sha256", sha256(tinyPng)))
                )
                .put(JSONObject()
                    .put("resourceId", "res:source-pdf")
                    .put("kind", "pdf")
                    .put("mediaType", "application/pdf")
                    .put("sourceUrl", pdfUrl)
                    .put("availability", "external")
                    .put("requiredForOffline", true)
                    .put("descriptor", JSONObject.NULL)
                )

            val fixture = buildPaperFixture(
                appearanceId = "posts/2026-11-18-offline-pkg-2611-60001/",
                paperId = "arxiv:2611.60001",
                sourceVersionId = "arxiv:2611.60001v1",
                sourceUrl = "https://arxiv.org/abs/2611.60001v1",
                pdfUrl = pdfUrl,
                pdfSha256 = expectedPdfSha,
                authors = listOf("Grace Hopper", "Claude Shannon"),
                htmlFragment = "<div class=\"post-content\" id=\"article-body\"><h2>离线包验证</h2><p>包含捆绑科学图：</p><img src=\"/audio-research-portal/$bundledPath\" alt=\"图1\"></div>",
                withSidecars = true,
                resources = resources,
                bundledAssets = mapOf(bundledPath to tinyPng),
            )
            publishSnapshotToMock(mock, listOf(fixture))
            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            repo.sync()

            val unEnrichedBeforeOpen = repo.papers().single()
            assertTrue(unEnrichedBeforeOpen.authors.isEmpty())

            var earlyPaperVerifiedInCallback = false
            val article = repo.article(unEnrichedBeforeOpen, onReadable = { early ->
                val currentInRepo = repo.papers().single()
                if (currentInRepo.original?.optBoolean("desktopDetailVerified") == true) {
                    ReadingSourceBinding.requireArticle(currentInRepo, early)
                    assertEquals(listOf("Grace Hopper", "Claude Shannon"), currentInRepo.authors)
                    earlyPaperVerifiedInCallback = true
                }
            })
            assertTrue("onPaperEnriched must adopt enrichedPaper BEFORE onReadable fires", earlyPaperVerifiedInCallback)
            assertTrue("External PDF resource must not block guide completeOffline", article.completeOffline)

            // Also test cached `desktopCurrent` fast path when passed the older un-enriched Paper instance:
            val cachedFastArticle = repo.article(unEnrichedBeforeOpen, refresh = false)
            val boundPaper = repo.papers().single()
            ReadingSourceBinding.requireArticle(boundPaper, cachedFastArticle)

            // Stage verified local PDF + pointer receipt (headless JVM unit test has context = null) and run downloadPDF + OfflineStore.register + open!
            val localPdfFile = File(dir, "PublishedLibrary/pdf/$expectedPdfSha.pdf")
            JsonFiles.write(localPdfFile, samplePdfBytes)
            val pointerFile = File(dir, "PublishedLibrary/pdf-pointers/${sha256(pdfUrl.toByteArray())}.json")
            JsonFiles.write(pointerFile, JSONObject()
                .put("filePath", localPdfFile.absolutePath)
                .put("sha256", expectedPdfSha)
                .put("bytes", samplePdfBytes.size.toLong())
                .put("version", boundPaper.sourceVersion)
                .put("paperID", boundPaper.id)
                .put("sourceURL", pdfUrl)
                .put("fetchedAt", now())
                .put("validatedAt", now())
                .put("catalogEpoch", repo.epoch())
                .put("isStale", false)
            )
            val (pdfFile, pdfSha) = repo.downloadPDF(boundPaper)
            ReadingSourceBinding.requirePDF(boundPaper, repo.pdfReceipt(boundPaper.id), pdfSha)
            val offlineStore = OfflineStore(personal.directory)
            val registered = offlineStore.register(boundPaper, article, pdfFile)
            assertFalse(registered.getBoolean("reused"))
            val opened = offlineStore.open(registered.getString("id"))
            assertEquals("arxiv:2611.60001", opened.paper.id)
            assertNotNull(opened.pdfFile)
            assertTrue("Opened offline package embeds base64 PNG image", opened.article.html.contains("data:image/png;base64,"))
        }
    }

    @Test
    fun citationOriginalIncludesBindingAndColdVerifiesDetailAndArticleOnDisk() = runBlocking {
        withWorkspace { dir, personal ->
            val mock = MockSite()
            val item = buildPaperFixture(
                appearanceId = "posts/2026-11-18-citation-cold-2611-60002/",
                paperId = "arxiv:2611.60002",
                sourceVersionId = "arxiv:2611.60002v1",
                sourceUrl = "https://arxiv.org/abs/2611.60002v1",
                pdfUrl = "https://arxiv.org/pdf/2611.60002v1.pdf",
                withSidecars = true,
            )
            publishSnapshotToMock(mock, listOf(item))
            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            repo.sync()

            val article = repo.article(repo.papers().single())
            val enrichedPaper = repo.papers().single()

            val schema = ClientProtocols.declaredSchema(
                ClientProtocols.contract("published-citation-original"),
                "published-citation-original",
                ClientProtocols.schemaFingerprint("published-citation-original"),
            )
            val expectedMetaKeys = setOf("contract", "schemaFingerprint") + schema.getJSONArray("fields").strings()

            for (fmt in listOf(PublishedCitationRepository.Format.JSON, PublishedCitationRepository.Format.BIBTEX, PublishedCitationRepository.Format.RIS)) {
                val orig = repo.citationOriginal(enrichedPaper, article, fmt)
                val meta = orig.metadata()
                assertTrue(ClientProtocols.hasValidHeader(meta, "published-citation-original"))
                assertEquals(expectedMetaKeys, meta.keys().asSequence().toSet())
                val bindingObj = meta.getJSONObject("binding")
                assertEquals(enrichedPaper.id, bindingObj.getJSONObject("paper").getString("id"))
                assertEquals(article.revisionSHA256, bindingObj.getString("articleRevisionSHA256"))
                assertTrue(meta.getBoolean("bundleHashVerified"))
            }

            // Tampering 1 byte in cached `desktop-details/papers/<detailSha>.json` on disk MUST fail closed!
            val detailSha = item.detailDescriptor.getString("sha256")
            val cachedDetailFile = File(dir, "PublishedLibrary/desktop-details/papers/$detailSha.json")
            val validDetailBytes = cachedDetailFile.readBytes()
            val tamperedDetail = validDetailBytes.copyOf().also { it[it.size - 1] = ' '.code.toByte() }
            cachedDetailFile.writeBytes(tamperedDetail)
            assertTrue(
                "citationOriginal must cold-verify papers/<detailSha>.json and reject tampering",
                runCatching { repo.citationOriginal(enrichedPaper, article, PublishedCitationRepository.Format.BIBTEX) }.isFailure,
            )

            // Restore detail file, then tamper 1 byte in cached `desktop-details/articles/<artSha>.html` -> MUST fail closed!
            cachedDetailFile.writeBytes(validDetailBytes)
            val artSha = item.articleDescriptor.getString("sha256")
            val cachedArticleFile = File(dir, "PublishedLibrary/desktop-details/articles/$artSha.html")
            val validArtBytes = cachedArticleFile.readBytes()
            cachedArticleFile.writeBytes(validArtBytes + byteArrayOf(' '.code.toByte()))
            assertTrue(
                "citationOriginal must cold-verify articles/<artSha>.html and reject tampering",
                runCatching { repo.citationOriginal(enrichedPaper, article, PublishedCitationRepository.Format.RIS) }.isFailure,
            )
        }
    }

    @Test
    fun strictJsonAndStrictStreamJsonRfc8259AndConferencePaperIdConformance() = runBlocking {
        fun parseBoth(jsonText: String): Pair<JSONObject, JSONObject> {
            val a = DesktopDetailsRepository.StrictJson.parseObject(jsonText.toByteArray(Charsets.UTF_8), "test")
            val b = java.io.StringReader(jsonText).use { raw ->
                val s = StrictStreamJson(raw)
                val v = s.readValue(0) as JSONObject
                s.expectEndDocument()
                v
            }
            return a to b
        }

        fun assertBothReject(label: String, jsonText: String) {
            assertTrue(
                "StrictJson must reject $label: $jsonText",
                runCatching { DesktopDetailsRepository.StrictJson.parseObject(jsonText.toByteArray(Charsets.UTF_8), label) }.isFailure,
            )
            assertTrue(
                "StrictStreamJson must reject $label: $jsonText",
                runCatching {
                    java.io.StringReader(jsonText).use { raw ->
                        val s = StrictStreamJson(raw)
                        s.readValue(0)
                        s.expectEndDocument()
                    }
                }.isFailure,
            )
        }

        // Valid RFC 8259 inputs: surrogate pairs, \u0000 escape, -0, scientific notation, safe 53-bit integers, across 8192-char boundary!
        val pad8185 = "x".repeat(8180) // Pushes surrogate pair right across the 8192-char StrictStreamJson buffer boundary!
        val validJson = "{\"pad\":\"$pad8185\\uD83D\\uDE00😀\",\"nul\":\"a\\u0000b\",\"negZero\":-0,\"sci\":1.25e-5,\"maxSafe\":9007199254740991,\"minSafe\":-9007199254740991}"
        val (strictObj, streamObj) = parseBoth(validJson)
        assertEquals(strictObj.getString("pad"), streamObj.getString("pad"))
        assertTrue(streamObj.getString("pad").endsWith("😀😀"))
        assertEquals("a\u0000b", strictObj.getString("nul"))
        assertEquals("a\u0000b", streamObj.getString("nul"))
        assertEquals(0, (strictObj.get("negZero") as Number).toInt())
        assertEquals(0, (streamObj.get("negZero") as Number).toInt())
        assertEquals(9007199254740991L, strictObj.getLong("maxSafe"))
        assertEquals(9007199254740991L, streamObj.getLong("maxSafe"))

        // Reject invalid hex escapes, lone surrogates, raw control chars, non-finite/overflow numbers, dup keys, trailing comma/garbage, depth > 64
        assertBothReject("signed + hex", "{\"a\":\"\\u+041\"}")
        assertBothReject("signed - hex", "{\"a\":\"\\u-001\"}")
        assertBothReject("fullwidth hex", "{\"a\":\"\\u００４１\"}")
        assertBothReject("arabic hex", "{\"a\":\"\\u٠٦٦٠\"}")
        assertBothReject("lone high surrogate escape", "{\"a\":\"\\uD83D\"}")
        assertBothReject("lone low surrogate escape", "{\"a\":\"\\uDE00\"}")
        assertBothReject("high surrogate + non-surrogate", "{\"a\":\"\\uD83D\\u0041\"}")
        assertBothReject("raw NUL control char", "{\"a\":\"\u0000\"}")
        assertBothReject("raw 0x1F control char", "{\"a\":\"\u001F\"}")
        assertBothReject("1e400 Infinity overflow", "{\"n\":1e400}")
        assertBothReject("NaN literal", "{\"n\":NaN}")
        assertBothReject("Infinity literal", "{\"n\":Infinity}")
        assertBothReject(">53-bit integer overflow", "{\"n\":9007199254740992}")
        assertBothReject(">64-bit integer overflow", "{\"n\":999999999999999999999999}")
        assertBothReject("trailing comma object", "{\"a\":1,}")
        assertBothReject("trailing comma array", "{\"a\":[1,2,]}")
        assertBothReject("duplicate key", "{\"a\":1,\"a\":2}")
        assertBothReject("duplicate null key", "{\"a\":null,\"a\":1}")
        assertBothReject("trailing garbage", "{\"a\":1} trailing")
        val deep66 = "{\"x\":".repeat(66) + "1" + "}".repeat(66)
        assertBothReject("nesting depth > 64", deep66)

        // Invalid conference paperId (containing NUL or slash) MUST fail closed during sync()
        for (badConfId in listOf("conference:interspeech:2026:bad\u0000id", "conference:interspeech/bad")) {
            withWorkspace { _, personal ->
                val mock = MockSite()
                val badConf = buildPaperFixture(
                    appearanceId = "posts/conference-bad-id/",
                    paperId = badConfId,
                    sourceKind = "conference",
                    sourceVersionId = null,
                    sourceUrl = "https://www.isca-archive.org/interspeech_2026/a.html",
                    pdfUrl = "https://www.isca-archive.org/interspeech_2026/a.pdf",
                )
                publishSnapshotToMock(mock, listOf(badConf))
                val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
                assertTrue("Invalid conference paperId must fail closed: $badConfId", runCatching { repo.sync() }.isFailure)
            }
        }
    }

    @Test
    fun positiveUrlAllowlistAndNonPdfOfflineAccountingMissingImageDedupAndAuthorHygiene() = runBlocking {
        // 1. Positive URL allowlist: valid static LaTeXML SVG (including xmlns:xlink + #fragment + LaTeXML style) materialized into assets/<sha> & ArticleImageAccess + OfflineStore
        val safeSvgBytes = "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" style=\"vertical-align:2.98px\" viewBox=\"0 0 20 20\"><defs><path id=\"g1\" d=\"M1 1 L19 19\"/></defs><g style=\"--ltx-stroke-color:#000000;--ltx-fill-color:#000000\"><rect x=\"1\" y=\"1\" width=\"18\" height=\"18\" fill=\"none\" stroke=\"#000\"/><use xlink:href=\"#g1\"/></g></svg>".toByteArray(Charsets.UTF_8)
        val safeSvgB64 = java.util.Base64.getEncoder().encodeToString(safeSvgBytes)
        withWorkspace { dir, personal ->
            val mock = MockSite()
            val safeHtml = "<div class=\"post-content\" id=\"article-body\"><p>联系作者 <a href=\"mailto:author@example.edu\">邮件</a></p><img src=\"data:image/svg+xml;base64,$safeSvgB64\" alt=\"LaTeXML矢量图\"></div>"
            val svgItem = buildPaperFixture(
                appearanceId = "posts/2026-11-18-safe-svg-2611-70001/",
                paperId = "arxiv:2611.70001",
                sourceVersionId = "arxiv:2611.70001v1",
                sourceUrl = "https://arxiv.org/abs/2611.70001v1",
                pdfUrl = "https://arxiv.org/pdf/2611.70001v1.pdf",
                htmlFragment = safeHtml,
            )

            // 2. `<img src="icassp-img://...">` with `availability == "missing"` -> 1 ArticleResource (no dup) + 0 image network fetches
            val icasspRes = JSONArray().put(JSONObject()
                .put("resourceId", "res:icassp-missing")
                .put("kind", "image")
                .put("mediaType", "image/png")
                .put("sourceUrl", "icassp-img://2025/fig1.png")
                .put("availability", "missing")
                .put("requiredForOffline", true)
                .put("descriptor", JSONObject.NULL)
            )
            val icasspItem = buildPaperFixture(
                appearanceId = "posts/2026-11-18-icassp-missing-2611-70002/",
                paperId = "arxiv:2611.70002",
                sourceVersionId = "arxiv:2611.70002v1",
                sourceUrl = "https://arxiv.org/abs/2611.70002v1",
                pdfUrl = "https://arxiv.org/pdf/2611.70002v1.pdf",
                htmlFragment = "<div class=\"post-content\" id=\"article-body\"><p>历史缺失图</p><img src=\"icassp-img://2025/fig1.png\" alt=\"缺失图1\"></div>",
                resources = icasspRes,
            )

            // 3. External required `video` resource -> completeOffline MUST be false even with zero missing images!
            val videoRes = JSONArray().put(JSONObject()
                .put("resourceId", "res:ext-video")
                .put("kind", "video")
                .put("mediaType", "video/mp4")
                .put("sourceUrl", "https://nanless.github.io/audio-research-portal/media/demo.mp4")
                .put("availability", "external")
                .put("requiredForOffline", true)
                .put("descriptor", JSONObject.NULL)
            )
            val videoItem = buildPaperFixture(
                appearanceId = "posts/2026-11-18-video-res-2611-70003/",
                paperId = "arxiv:2611.70003",
                sourceVersionId = "arxiv:2611.70003v1",
                sourceUrl = "https://arxiv.org/abs/2611.70003v1",
                pdfUrl = "https://arxiv.org/pdf/2611.70003v1.pdf",
                authors = listOf("Author V1"),
                resources = videoRes,
            )

            // 4. Uncached external DOM image with `requiredForOffline = false` MUST STILL keep `completeOffline = false`!
            val optionalExtUrl = "https://arxiv.org/html/2611.70004v1/unfetched-opt.png"
            val optionalExtRes = JSONArray().put(JSONObject()
                .put("resourceId", "res:opt-ext-img")
                .put("kind", "image")
                .put("mediaType", "image/png")
                .put("sourceUrl", optionalExtUrl)
                .put("availability", "external")
                .put("requiredForOffline", false)
                .put("descriptor", JSONObject.NULL)
            )
            val optionalExtItem = buildPaperFixture(
                appearanceId = "posts/2026-11-18-opt-ext-img-2611-70004/",
                paperId = "arxiv:2611.70004",
                sourceVersionId = "arxiv:2611.70004v1",
                sourceUrl = "https://arxiv.org/abs/2611.70004v1",
                pdfUrl = "https://arxiv.org/pdf/2611.70004v1.pdf",
                htmlFragment = "<div class=\"post-content\" id=\"article-body\"><p>可选外链图</p><img src=\"$optionalExtUrl\" alt=\"外链图\"></div>",
                resources = optionalExtRes,
            )

            publishSnapshotToMock(mock, listOf(svgItem, icasspItem, videoItem, optionalExtItem), sourceCommit = "1".repeat(40))
            val repo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            repo.sync()

            val svgArticle = repo.article(repo.papers().single { it.id == "arxiv:2611.70001" })
            val svgPaper = repo.papers().single { it.id == "arxiv:2611.70001" }
            assertTrue(svgArticle.completeOffline)
            assertEquals(1, svgArticle.resources.size)
            assertEquals(sha256(safeSvgBytes), svgArticle.resources.single().sha256)
            val displayImages = requireNotNull(svgArticle.displayImages)
            val renderedImg = org.jsoup.Jsoup.parseBodyFragment(displayImages.bodyHTML).selectFirst("img")
            assertNotNull("Inline data:image/svg+xml must render as <img> in ArticleImageAccess.bodyHTML", renderedImg)
            val (servedMime, servedStream) = requireNotNull(displayImages.open(renderedImg!!.attr("src"), false, "GET"))
            assertEquals("image/svg+xml", servedMime)
            assertArrayEquals(safeSvgBytes, servedStream.use { it.readBytes() })

            val svgOfflineStore = OfflineStore(personal.directory)
            val svgPkg = svgOfflineStore.register(svgPaper, svgArticle)
            val openedSvgPkg = svgOfflineStore.open(svgPkg.getString("id"))
            assertTrue(openedSvgPkg.article.html.contains("data:image/svg+xml;base64,$safeSvgB64"))

            val optionalExtArticle = repo.article(repo.papers().single { it.id == "arxiv:2611.70004" })
            assertFalse("Uncached external image must keep completeOffline=false even when requiredForOffline=false", optionalExtArticle.completeOffline)

            mock.requests.clear()
            val icasspArticle = repo.article(repo.papers().single { it.id == "arxiv:2611.70002" })
            assertFalse(icasspArticle.completeOffline)
            assertEquals("Missing icassp-img must not produce duplicate ArticleResource entries", 1, icasspArticle.resources.size)
            assertFalse(mock.requests.any { it.contains("icassp-img") || it.contains("fig1.png") })

            val videoArticle = repo.article(repo.papers().single { it.id == "arxiv:2611.70003" })
            assertFalse("Required external video resource must keep completeOffline=false", videoArticle.completeOffline)
            assertEquals(listOf("Author V1"), repo.papers().single { it.id == "arxiv:2611.70003" }.authors)

            // 5. Author hygiene: when S2 changes `detail.sha256` for arxiv:2611.70003, stale `Author V1` MUST NOT leak into S2 before S2's detail is fetched!
            val videoItemV2 = buildPaperFixture(
                appearanceId = "posts/2026-11-18-video-res-2611-70003/",
                paperId = "arxiv:2611.70003",
                sourceVersionId = "arxiv:2611.70003v1",
                sourceUrl = "https://arxiv.org/abs/2611.70003v1",
                pdfUrl = "https://arxiv.org/pdf/2611.70003v1.pdf",
                readerTitle = "修订版导读标题",
                authors = listOf("Author V2 Updated"),
            )
            publishSnapshotToMock(mock, listOf(svgItem, icasspItem, videoItemV2, optionalExtItem), sourceCommit = "2".repeat(40))
            repo.sync()
            val beforeV2DetailFetch = repo.papers().single { it.id == "arxiv:2611.70003" }
            assertTrue("Changed detail.sha256 must not carry over stale authors before new detail fetch", beforeV2DetailFetch.authors.isEmpty())
            repo.article(beforeV2DetailFetch, refresh = true)
            assertEquals(listOf("Author V2 Updated"), repo.papers().single { it.id == "arxiv:2611.70003" }.authors)

            // 5. Tampering 1 byte in cached `desktop-details/articles/<artSha>.html` on disk MUST fail closed on refresh!
            val svgArtSha = svgItem.articleDescriptor.getString("sha256")
            val cachedSvgArtFile = File(dir, "PublishedLibrary/desktop-details/articles/$svgArtSha.html")
            val tamperedArt = cachedSvgArtFile.readBytes().copyOf().also { it[0] = ' '.code.toByte() }
            cachedSvgArtFile.writeBytes(tamperedArt)
            assertTrue(
                "Tampered local articles/<sha>.html must fail closed instead of silently re-downloading or accepting",
                runCatching { repo.article(repo.papers().single { it.id == "arxiv:2611.70001" }, refresh = true) }.isFailure,
            )
        }

        // 6. Legacy `CatalogRepository.extractArticle` strips protocol-relative `//evil.example` and backslash URLs
        val legacyPaper = Paper(
            id = "arxiv:2611.79999",
            title = "Legacy Sanitizer Check",
            titleZh = "旧清洗器检查",
            date = "2026-11-18",
            blogURL = site + "posts/legacy-sanitize/",
            sourceKind = "arxiv",
            identityStatus = "verified",
            sourceVersion = "2611.79999v1",
            sourceURL = "https://arxiv.org/abs/2611.79999v1",
            pdfURL = "https://arxiv.org/pdf/2611.79999v1.pdf",
            citation = JSONObject(),
            appearances = listOf(site + "posts/legacy-sanitize/"),
        )
        val extracted = CatalogRepository.extractArticle(
            "<html><body><div id=\"article-body\" class=\"post-content\"><a href=\"//evil.example/path\">bad1</a><a href=\"\\\\evil.example\\path\">bad2</a><a href=\"#sec1\">ok</a></div></body></html>",
            legacyPaper,
        )
        assertFalse(extracted.html.contains("evil.example"))
        assertTrue(extracted.html.contains("href=\"#sec1\""))
    }

    @Test
    fun macosPortableBackupWitnessReconstructsAndroidStateAndFailsClosedOnTamper() = runBlocking {
        withWorkspace { dir, personal ->
            val mock = MockSite()
            val paperActive = buildPaperFixture(
                appearanceId = "posts/2026-11-18-macos-restored-2611-80001/",
                paperId = "arxiv:2611.80001",
                sourceVersionId = "arxiv:2611.80001v1",
                sourceUrl = "https://arxiv.org/abs/2611.80001v1",
                pdfUrl = "https://arxiv.org/pdf/2611.80001v1.pdf",
                readerTitle = "从 macOS 跨端备份恢复的论文",
            )
            val dailyAgg = buildAggregateRow("posts/2026-11-18/", "daily", "2026-11-18 语音论文速递")
            val activeTomb = JSONObject()
                .put("appearanceId", "posts/2026-11-15-macos-removed-2611-80002/")
                .put("paperId", "arxiv:2611.80002")
                .put("previousArticleRevisionId", "b".repeat(64))
                .put("reason", "site-removed")
                .put("effectiveAt", "2026-11-18T06:00:00Z")
                .put("sourceCommit", "c".repeat(40))
                .put("replacementAppearanceId", JSONObject.NULL)
                .put("evidenceUrl", JSONObject.NULL)
                .put("note", "macOS 下架记录")

            val sourceCommit = "c".repeat(40)
            val (snapshotId, _) = publishSnapshotToMock(
                mock = mock,
                items = listOf(paperActive),
                aggregateRows = listOf(dailyAgg),
                tombstones = listOf(activeTomb),
                sourceCommit = sourceCommit,
            )

            // Sync once to build a valid `current.json` + immutable `snapshots/`, `catalog/`, `tombstones/`, then strip Android-specific state files
            // and install a real macOS `desktop-details/macos-states/<snapshotId>-<epoch>.json` witness!
            val seedRepo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            seedRepo.sync()
            val epoch = seedRepo.epoch()

            File(dir, "PublishedLibrary/desktop-details/states").deleteRecursively()
            File(dir, "PublishedLibrary/desktop-details/tombstone-states").deleteRecursively()
            File(dir, "PublishedLibrary/aggregates").deleteRecursively()

            val macosHistoryEvents = JSONArray()
                .put(JSONObject()
                    .put("kind", "removed")
                    .put("appearanceId", "posts/2026-11-15-macos-removed-2611-80002/")
                    .put("paperId", "arxiv:2611.80002")
                    .put("previousArticleRevisionId", "b".repeat(64))
                    .put("restoredArticleRevisionId", JSONObject.NULL)
                    .put("reason", "site-removed")
                    .put("effectiveAt", "2026-11-18T06:00:00Z")
                    .put("sourceCommit", sourceCommit)
                    .put("replacementAppearanceId", JSONObject.NULL)
                    .put("evidenceUrl", JSONObject.NULL)
                    .put("note", "macOS 下架记录")
                    .put("observedSnapshotId", snapshotId)
                    .put("observedAt", "2026-11-18T06:05:00Z")
                )
                .put(JSONObject()
                    .put("kind", "restored")
                    .put("appearanceId", "posts/2026-11-18-macos-restored-2611-80001/")
                    .put("paperId", "arxiv:2611.80001")
                    .put("previousArticleRevisionId", "d".repeat(64))
                    .put("restoredArticleRevisionId", paperActive.catalogRow.getString("articleRevisionId"))
                    .put("reason", "site-removed")
                    .put("effectiveAt", "2026-11-18T07:00:00Z")
                    .put("sourceCommit", sourceCommit)
                    .put("replacementAppearanceId", JSONObject.NULL)
                    .put("evidenceUrl", JSONObject.NULL)
                    .put("note", JSONObject.NULL)
                    .put("observedSnapshotId", snapshotId)
                    .put("observedAt", "2026-11-18T07:05:00Z")
                )

            val macosWitness = JSONObject()
                .put("contract", DesktopDetailsRepository.MACOS_STATE_CONTRACT)
                .put("snapshotID", snapshotId)
                .put("validationEpoch", epoch)
                .put("sourceCommit", sourceCommit)
                .put("generatedAt", "2026-11-18T07:05:00Z")
                .put("basePath", "/audio-paper-digest-blog/")
                .put("paperDetails", JSONObject())
                .put("aggregateDetails", JSONObject())
                .put("activeTombstones", JSONArray().put(activeTomb))
                .put("tombstoneHistory", macosHistoryEvents)

            // Verify legacy v1.4.7 basePath transition boundary strictly accepts /audio-paper-digest-blog/ on nanless.github.io only
            assertTrue(DesktopDetailsRepository.isAcceptedSiteBasePath("/audio-research-portal/", CatalogRepository.SITE))
            assertTrue(DesktopDetailsRepository.isAcceptedSiteBasePath("/audio-paper-digest-blog/", CatalogRepository.SITE))
            assertFalse(DesktopDetailsRepository.isAcceptedSiteBasePath("/other-blog/", CatalogRepository.SITE))
            assertFalse(DesktopDetailsRepository.isAcceptedSiteBasePath("/audio-paper-digest-blogging/", CatalogRepository.SITE))
            assertFalse(DesktopDetailsRepository.isAcceptedSiteBasePath("/audio-paper-digest-blog/", "https://evil.example/audio-research-portal/"))

            val macosStateFile = File(dir, "PublishedLibrary/desktop-details/macos-states/$snapshotId-$epoch.json")
            JsonFiles.write(macosStateFile, macosWitness.toString().toByteArray(Charsets.UTF_8))

            // 1. Cold-load CatalogRepository on Android from macOS-restored workspace -> succeeds, opens article, imports tombstoneHistory & aggregates!
            val restoredRepo = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
            assertEquals(1, restoredRepo.papers().size)
            assertEquals(1, restoredRepo.aggregateCatalog()!!.records.size)
            val history = restoredRepo.tombstoneHistory()
            assertEquals(1, history.getJSONObject("currentTombstones").length())
            val eventTypes = history.getJSONArray("events").objects().map { it.getString("eventType") }
            assertEquals(listOf("tombstone", "restored"), eventTypes)
            val article = restoredRepo.article(restoredRepo.papers().single())
            assertTrue(article.html.contains("核心导读"))

            // 2. Subsequent Android sync prunes old Android `states/` & `tombstone-states/`, NEVER deleting `macos-states/`!
            val nextPaper = buildPaperFixture(
                appearanceId = "posts/2026-11-19-next-sync-2611-80003/",
                paperId = "arxiv:2611.80003",
                sourceVersionId = "arxiv:2611.80003v1",
                sourceUrl = "https://arxiv.org/abs/2611.80003v1",
                pdfUrl = "https://arxiv.org/pdf/2611.80003v1.pdf",
            )
            publishSnapshotToMock(mock, listOf(paperActive, nextPaper), sourceCommit = "e".repeat(40))
            restoredRepo.sync()
            assertTrue("pruneSupersededStates must never delete macos-states/", macosStateFile.isFile)
        }

        // 3. Negative checks: tampered witness, tampered catalog shard, missing tombstone shard, or corrupted Android state file MUST fail closed!
        for (mode in listOf("bad-witness-commit", "tampered-catalog-shard", "missing-tombstone-shard", "corrupt-android-state")) {
            withWorkspace { dir, personal ->
                val mock = MockSite()
                val p = buildPaperFixture(
                    appearanceId = "posts/2026-11-18-neg-$mode-2611-80009/",
                    paperId = "arxiv:2611.80009",
                    sourceVersionId = "arxiv:2611.80009v1",
                    sourceUrl = "https://arxiv.org/abs/2611.80009v1",
                    pdfUrl = "https://arxiv.org/pdf/2611.80009v1.pdf",
                )
                val tomb = JSONObject()
                    .put("appearanceId", "posts/2026-11-14-removed-$mode/")
                    .put("paperId", "arxiv:2611.89999")
                    .put("previousArticleRevisionId", "1".repeat(64))
                    .put("reason", "site-removed")
                    .put("effectiveAt", "2026-11-18T06:00:00Z")
                    .put("sourceCommit", "a".repeat(40))
                    .put("replacementAppearanceId", JSONObject.NULL)
                    .put("evidenceUrl", JSONObject.NULL)
                    .put("note", JSONObject.NULL)
                val (snapId, _) = publishSnapshotToMock(mock, listOf(p), tombstones = listOf(tomb), sourceCommit = "a".repeat(40))
                val seed = CatalogRepository(null, personal) { url, limit -> mock.fetch(url, limit) }
                seed.sync()
                val ep = seed.epoch()
                File(dir, "PublishedLibrary/desktop-details/states").deleteRecursively()
                File(dir, "PublishedLibrary/desktop-details/tombstone-states").deleteRecursively()

                val witness = JSONObject()
                    .put("contract", DesktopDetailsRepository.MACOS_STATE_CONTRACT)
                    .put("snapshotID", snapId)
                    .put("validationEpoch", ep)
                    .put("sourceCommit", if (mode == "bad-witness-commit") "f".repeat(40) else "a".repeat(40))
                    .put("generatedAt", "2026-11-18T07:05:00Z")
                    .put("basePath", "/audio-research-portal/")
                    .put("tombstoneHistory", JSONArray())
                JsonFiles.write(
                    File(dir, "PublishedLibrary/desktop-details/macos-states/$snapId-$ep.json"),
                    witness.toString().toByteArray(Charsets.UTF_8),
                )

                when (mode) {
                    "tampered-catalog-shard" -> {
                        val shard = File(dir, "PublishedLibrary/desktop-details/catalog").listFiles()!!.single()
                        shard.writeBytes(shard.readBytes().also { it[0] = ' '.code.toByte() })
                    }
                    "missing-tombstone-shard" -> {
                        File(dir, "PublishedLibrary/desktop-details/tombstones").deleteRecursively()
                    }
                    "corrupt-android-state" -> {
                        val badAndroid = File(dir, "PublishedLibrary/desktop-details/states/$snapId-$ep.json")
                        badAndroid.parentFile!!.mkdirs()
                        badAndroid.writeText("{\"corrupt\":1}", Charsets.UTF_8)
                    }
                }

                assertTrue(
                    "macOS witness reconstruction must fail closed on $mode",
                    runCatching { CatalogRepository(null, personal) { _, _ -> error("No network") } }.isFailure,
                )
            }
        }
    }

    @Test
    fun `inline SVG allows metadata and quoted internal fragment url in style and optional real blog corpus verifies cleanly`() = runBlocking {
        // 1. Quoted internal fragment url('#c1') + <metadata> + xmlns:xlink MUST pass both SVG static check and CatalogRepository.imageMime
        val quotedClipSvg = """<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><metadata>LaTeXML</metadata><defs><clipPath id="c1"><rect width="10" height="10"/></clipPath><circle id="dot" cx="5" cy="5" r="4"/></defs><g clip-path="url(#c1)" style="clip-path: url('#c1'); --ltx-stroke-color:#000000"><use xlink:href="#dot"/></g></svg>"""
        val b64 = java.util.Base64.getEncoder().encodeToString(quotedClipSvg.toByteArray(Charsets.UTF_8))
        val sanitized = DesktopDetailsRepository.verifyAndSanitizeArticleHtml(
            "<div class=\"post-content\" id=\"article-body\"><p>字符 \uFFFD 测试</p><img src=\"data:image/svg+xml;base64,$b64\" alt=\"svg\"/></div>".toByteArray(Charsets.UTF_8),
            site + "posts/2026-11-19-svg-quoted-clip/",
        )
        assertEquals(1, sanitized.inlineDataBytesByElement.size)

        // Adversarial SVG vectors (CSS comment-in-string desync, image-set, presentation attr external url, mismatched quote) MUST fail closed!
        val badSvgs = listOf(
            """<svg xmlns="http://www.w3.org/2000/svg"><g style="clip-path: url('#a/*'); background-image: url(https://evil.example/leak.png); --x: ('*/b')"><rect width="1" height="1"/></g></svg>""",
            """<svg xmlns="http://www.w3.org/2000/svg"><g style="background-image: image-set('leak.png' 1x)"><rect width="1" height="1"/></g></svg>""",
            """<svg xmlns="http://www.w3.org/2000/svg"><g clip-path="url(https://evil.example/sprite.svg#c)"><rect width="1" height="1"/></g></svg>""",
            """<svg xmlns="http://www.w3.org/2000/svg"><g style="clip-path: url('#c1&quot;)"><rect width="1" height="1"/></g></svg>""",
        )
        for (badSvg in badSvgs) {
            val badB64 = java.util.Base64.getEncoder().encodeToString(badSvg.toByteArray(Charsets.UTF_8))
            assertTrue(
                "Adversarial SVG must fail closed: $badSvg",
                runCatching {
                    DesktopDetailsRepository.verifyAndSanitizeArticleHtml(
                        "<div class=\"post-content\" id=\"article-body\"><img src=\"data:image/svg+xml;base64,$badB64\" alt=\"bad\"/></div>".toByteArray(Charsets.UTF_8),
                        site + "posts/2026-11-19-bad-svg/",
                    )
                }.isFailure && runCatching { DesktopDetailsRepository.verifyDesktopImageBytes(badSvg.toByteArray(Charsets.UTF_8)) }.isFailure,
            )
        }

        // 1B. Verify <article>/<main>/<picture> unwrapping, harmless <audio>/<video> stripping, and data:image/jpg parity (E-M3)
        val tinyJpgBytes = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff.toByte(), 0xd9.toByte())
        val tinyJpgB64 = java.util.Base64.getEncoder().encodeToString(tinyJpgBytes)
        val wrapperHtml = "<div class=\"post-content\" id=\"article-body\"><article><main><p>结构正文</p><picture><source srcset=\"https://nanless.github.io/audio-research-portal/a.webp\"><img src=\"data:image/jpg;base64,$tinyJpgB64\" alt=\"图\"></picture><audio controls><source src=\"https://nanless.github.io/audio-research-portal/a.mp3\"></audio></main></article></div>"
        val sanitizedWrapper = DesktopDetailsRepository.verifyAndSanitizeArticleHtml(
            wrapperHtml.toByteArray(Charsets.UTF_8),
            site + "posts/2026-11-20-wrapper-parity/",
        )
        assertTrue(sanitizedWrapper.body.html().contains("结构正文"))
        assertEquals(1, sanitizedWrapper.inlineDataBytesByElement.size)
        assertFalse(sanitizedWrapper.body.html().contains("<audio"))

        // 2. Optional full real-corpus verification when PD_REAL_BLOG_PUBLIC_DIR is provided
        val realDirPath = System.getenv("PD_REAL_BLOG_PUBLIC_DIR")?.takeIf { it.isNotBlank() } ?: return@runBlocking
        val publicRoot = File(realDirPath)
        assertTrue("PD_REAL_BLOG_PUBLIC_DIR missing client/details/manifest.json", File(publicRoot, "client/details/manifest.json").isFile)

        withWorkspace { _, personal ->
            val repo = CatalogRepository(null, personal) { url, limit ->
                require(url.startsWith(site)) { "Unexpected external fetch during real blog sync: $url" }
                val rel = url.removePrefix(site)
                val f = File(publicRoot, rel)
                if (!f.isFile) throw PublishedHttpStatus(404)
                val bytes = f.readBytes()
                require(bytes.size <= limit) { "Real file exceeds limit: $rel" }
                bytes
            }
            repo.sync()
            val papers = repo.papers()
            assertTrue("Expected >8000 deduplicated papers, got ${papers.size}", papers.size > 8000)

            // Verify EVERY SINGLE exported HTML fragment in public/client/details/articles/
            val articleFiles = File(publicRoot, "client/details/articles").listFiles().orEmpty().filter { it.extension == "html" }
            assertTrue("Expected >8500 HTML fragments, got ${articleFiles.size}", articleFiles.size > 8500)
            for (f in articleFiles) {
                DesktopDetailsRepository.verifyAndSanitizeArticleHtml(f.readBytes(), site + "posts/real-corpus-check/")
            }

            // End-to-end article reads + citationOriginal on real edge-case papers
            val fffdPaper = papers.first { it.id == "conference:icml:2026:openreview-forum-id:aComqAqP6j" }
            val fffdArt = repo.article(fffdPaper)
            assertTrue(fffdArt.plainText.contains("\uFFFD"))

            val pctSvgPaper = papers.first { it.id == "arxiv:2606.26968" }
            val pctSvgArt = repo.article(pctSvgPaper)
            assertTrue(pctSvgArt.resources.any { it.localPath != null && it.sourceURL.contains("/inline-data/") })

            val b64SvgPaper = papers.first { it.id == "arxiv:2607.00548" }
            val b64SvgArt = repo.article(b64SvgPaper)
            assertTrue(b64SvgArt.resources.any { it.localPath != null && it.sourceURL.contains("/inline-data/") })

            val arxivBundledPaper = papers.first { it.id == "arxiv:2611.19145" }
            val arxivBundledArt = repo.article(arxivBundledPaper)
            assertTrue(arxivBundledArt.completeOffline)
            val bib = repo.citationOriginal(arxivBundledPaper, arxivBundledArt, PublishedCitationRepository.Format.BIBTEX)
            assertTrue(bib.bytes.isNotEmpty())
        }
    }
}
