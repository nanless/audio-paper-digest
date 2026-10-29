package com.nanless.paperdigest.data

import android.content.Context
import android.net.Uri
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.ui.ResearchRenderer
import com.nanless.paperdigest.zotero.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One materials builder feeds exports and Zotero; original sealed records remain immutable. */
class ExportService(private val context: Context, private val store: PersonalStore, private val study: StudyService,
    private val publishedRecords: suspend (Paper) -> JSONObject = { PublishedRecordArchive.unavailable("尚未绑定原始目录读取器") },
    private val citationOriginal: suspend (Paper, Article, PublishedCitationRepository.Format, () -> Unit) -> PublishedCitationRepository.Original = { _, _, _, _ -> throw AppFailure("citationUnavailable", "尚未绑定真实已发布引用读取器；未生成替代引用") }) {
    private val directory by lazy { ExportArtifactWriter.directory(File(context.noBackupFilesDir.canonicalFile, "PaperDigestTransfers/Exports")) }
    data class Prepared(val id: String, val file: File, val mime: String, val name: String, val sha256: String) {
        fun json() = JSONObject().put("documentID", id).put("mime", mime).put("suggestedName", name).put("bytes", file.length()).put("sha256", sha256)
    }
    private val artifactWriter by lazy { ExportArtifactWriter(directory) }
    fun register(file:File,mime:String,name:String,documentID:String=UUID.randomUUID().toString(),check:()->Unit={}):Prepared {
        ExportProducerReceipt.validatePortableBackup(file, directory, check)
        val item=artifactWriter.register(file,mime,name,documentID,check)
        return Prepared(item.id,item.file,item.mime,item.name,item.sha256)
    }
    fun registerCompleted(captured:ExportProducerReceipt.CompletedCapture,documentID:String,check:()->Unit={}):Prepared {
        ExportProducerReceipt.validatePortableBackup(captured.file, directory, check)
        val item=artifactWriter.completed(captured.file,captured.mime,captured.name,documentID,captured.sha256,captured.bytes,check)
        return Prepared(item.id,item.file,item.mime,item.name,item.sha256)
    }
    private fun bytes(data:ByteArray,mime:String,name:String,documentID:String=UUID.randomUUID().toString(),check:()->Unit={}):Prepared {
        val item=artifactWriter.bytes(data,mime,name,documentID,check)
        return Prepared(item.id,item.file,item.mime,item.name,item.sha256)
    }
    suspend fun prepare(format:String,paper:Paper?,article:Article?,pdf:File?,sessionID:String?=null,
        documentID:String=UUID.randomUUID().toString(),captureFile:File?=null,check:()->Unit={},
        phase:(String)->Unit={},producer:ExportProducerReceipt?=null):Prepared {
        check()
        fun outBytes(data:ByteArray,mime:String,name:String)=bytes(data,mime,name,documentID,check)
        fun outFile(file:File,mime:String,name:String)=register(file,mime,name,documentID,check)
        if (format == "backup") {
            require(captureFile==null||producer!=null){"本次完整快照必须绑定原生产回执"}
            val file=captureFile?:File(directory,".backup-${UUID.randomUUID()}")
            try {
                val completed=if(producer?.hasCompletionMaterials()==true)producer.verifiedCapture(check)else{
                    require(!java.nio.file.Files.exists(file.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS)){"原准备材料未有完成回执，保留原件且未重新采集"}
                    phase("capturing");val result=BackupCodec.capture(store.directory,file,check)
                    if(producer!=null)producer.recordVerifiedCapture(result,"application/octet-stream","论文速递工作台-${now().replace(':','-')}.paperdigest",check)
                    else ExportProducerReceipt.CompletedCapture(result.file,"application/octet-stream","论文速递工作台-${now().replace(':','-')}.paperdigest",result.encodedBytes,result.sha256,result.fileCount)
                }
                check();phase("encoding");return registerCompleted(completed,documentID,check)
            }finally{if(producer==null)file.delete()}
        }
        phase("encoding")
        if (format == "diagnostics") {
            // No account, endpoint, paper text, file paths, credentials or stable secret fingerprints.
            val s = store.snapshot()
            return outBytes(JSONObject().put("contract", "paperdigest-android-diagnostics-v1").put("generatedAt", now()).put("platform", "android")
                .put("sdk", android.os.Build.VERSION.SDK_INT).put("sessionCount", s.getJSONArray("sessions").length()).put("jobCount", s.getJSONArray("jobs").length())
                .put("noteCount", s.getJSONObject("notes").length()).toString(2).toByteArray(), "application/json", "论文速递工作台-诊断.json")
        }
        if (sessionID != null && format in listOf("research-json", "research-md", "research-html")) {
            val original = historicalResearch(sessionID)
            val owner = original.getJSONObject("historicalReference").getString("paperID")
            val name = "历史研究-${owner.replace(Regex("[^A-Za-z0-9_-]"), "-").take(60)}"
            return when (format) {
                "research-json" -> outBytes(original.toString(2).toByteArray(), "application/json", "$name.json")
                "research-md" -> outBytes(historicalMarkdown(original).toByteArray(), "text/markdown", "$name.md")
                else -> outBytes(htmlDocument("历史研究", ResearchRenderer.render(context, historicalMarkdown(original))).toByteArray(), "text/html", "$name.html")
            }
        }
        require(paper != null) { "请先选择论文" }
        if (format != "paper-pdf") ReadingSourceBinding.requireArticle(paper, article)
        val name = paper.titleZh.take(70)
        return when (format) {
            "paper-pdf" -> outFile(pdf ?: error("原文尚未保存"), "application/pdf", "$name.pdf")
            "citation-json", "bibtex", "ris" -> {
                val original=citationOriginal(paper,requireNotNull(article),PublishedCitationRepository.Format.fromRoute(format),check)
                check();outBytes(original.bytes,original.mime,original.filename)
            }
            "guide-html" -> {
                require(article != null && article.paperID == paper.id)
                outBytes(htmlDocument(paper.titleZh, articleBody(article), article.notices).toByteArray(), "text/html", "$name-导读.html")
            }
            "research-json", "research-md", "research-html" -> {
                val research = research(paper, article, sessionID)
                when (format) {
                    "research-json" -> outBytes(research.toString(2).toByteArray(), "application/json", "$name-研究.json")
                    "research-md" -> outBytes(researchMarkdown(paper, research).toByteArray(), "text/markdown", "$name-研究.md")
                    else -> outBytes(htmlDocument(paper.titleZh, ResearchRenderer.render(context, researchMarkdown(paper, research))).toByteArray(), "text/html", "$name-研究.html")
                }
            }
            else -> throw AppFailure("unsupported", "导出格式尚不支持")
        }
    }
    suspend fun save(uri: Uri, id: String): JSONObject = withContext(Dispatchers.IO) {
        UUID.fromString(id); externalDestination(context, uri.toString())
        val manifest = JSONObject(JsonFiles.read(File(directory, "$id.json")).toString(Charsets.UTF_8))
        require(manifest.getString("documentID") == id)
        val file = File(directory, "$id.bin")
        require(file.isFile && file.length() == manifest.getLong("bytes") && BackupCodec.hash(file) == manifest.getString("sha256")) { "待导出原件已变化" }
        ExportProducerReceipt.validatePortableBackup(file, directory)
        require(file.length() == manifest.getLong("bytes") && ExportArtifactWriter.digest(file,{}) == manifest.getString("sha256")) { "待导出原件在核验期间已变化" }
        context.contentResolver.openOutputStream(uri, "wt")?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error("无法写入用户选择的位置")
        JSONObject().put("saved", true).put("bytes", file.length()).put("sha256", manifest.getString("sha256")).put("message", "已完整写入选择的位置")
    }
    fun research(paper: Paper, article: Article?, selectedSession: String?, includeCurrentNotes: Boolean = true): JSONObject {
        ReadingSourceBinding.requireArticle(paper, article)
        val all = store.snapshot()
        val sessions = all.getJSONArray("sessions").objects().filter { it.optString("paperID") == paper.id && (selectedSession == null || it.optString("id") == selectedSession) }
        require(selectedSession == null || sessions.isNotEmpty()) { "所选研究不属于当前论文" }
        val materials = sessions.map { original ->
            val session = original.copy()
            if (session.optString("inputContract") == "android-study-input-v1" && session.optString("status") == "completed") study.verifySaved(session)
            // Carry exact original bytes; another platform must validate its own known contract before adoption.
            val id = session.getString("id"); UUID.fromString(id)
            val originals = JSONObject()
            val capturePattern = Regex(Regex.escape(id) + "-response-capture-[a-f0-9-]{36}\\.(?:bin|json)")
            val captureFiles = File(store.directory, "ModelUsage").listFiles()?.filter { capturePattern.matches(it.name) }?.sortedBy { it.name }.orEmpty()
            val suffixes = listOf("input.json", "response.bin", "response.json") + captureFiles.map { it.name.removePrefix("$id-") }
            suffixes.forEach { suffix ->
                val file = File(store.directory, "ModelUsage/$id-$suffix")
                if (file.isFile) {
                    val data = JsonFiles.read(file, 16 * 1024 * 1024L)
                    originals.put(suffix, JSONObject().put("sha256", sha256(data)).put("data", java.util.Base64.getEncoder().encodeToString(data)))
                }
            }
            session.put("originalMaterials", originals)
        }
        return JSONObject().put("contract", "paperdigest-portable-research-v1").put("paper", paper.json()).put("article", article?.json() ?: JSONObject.NULL)
            .also { if (includeCurrentNotes) it.put("note", store.note(paper.id)).put("annotations", JSONArray(store.annotations(paper.id))) }.put("sessions", JSONArray(materials))
            .put("exportedAt", now()).put("notice", "原材料与当前显示分开保留；历史平台的模型输入须按其原合同核验，费用未知不表示免费。")
    }
    /** Old signed inputs have no Paper record. Never attach today's catalog as their original bibliography. */
    fun historicalResearch(sessionID: String): JSONObject {
        val session = store.session(sessionID) ?: error("原研究记录不存在")
        val owner = session.getString("paperID")
        val result = research(Paper(owner, "原题录未封存", sourceKind = "unknown"), null, sessionID, includeCurrentNotes = false)
        result.put("paper", JSONObject.NULL).put("article", JSONObject.NULL)
            .put("historicalReference", JSONObject().put("paperID", owner)
                .put("metadataStatus", "not-sealed-with-original-input")
                .put("source", session.optJSONObject("source")?.copy() ?: JSONObject.NULL))
            .put("notice", "原研究与原始输入按实际身份保留；原输入未封存完整题录，未附当前目录或当前笔记冒充历史材料。")
        result.remove("note"); result.remove("annotations")
        return result
    }
    private fun historicalMarkdown(research: JSONObject): String = buildString {
        append("# 历史研究\n\n")
        append("${research.getString("notice")}\n\n")
        append("原来源：\n\n```json\n${research.getJSONObject("historicalReference")}\n```\n\n")
        research.getJSONArray("sessions").objects().forEach { session ->
            append("## ${session.optString("question")}\n\n${session.optString("answer", session.optString("text", session.optString("response")))}\n\n")
            append("实际来源与用量：\n\n```json\n${session.optJSONObject("source") ?: JSONObject()}\n${session.optJSONObject("usage") ?: JSONObject()}\n```\n\n")
        }
    }
    suspend fun zoteroMaterials(paper: Paper, article: Article?, pdf: File?, options: JSONObject, pdfReceipt: JSONObject? = null): ZoteroMaterials {
        ReadingSourceBinding.requireArticle(paper, article)
        val materials = mutableListOf<ZoteroMaterial>()
        val includeAnalysis = options.optBoolean("includeAnalysis", true)
        val includeNote = options.optBoolean("includeNote", true)
        val research = if (includeAnalysis) research(paper, article, options.nullableString("sessionID"), includeCurrentNotes = includeNote) else null
        // Preview time is not a change to the actual archived research.
        research?.remove("exportedAt")
        if (!includeNote) { research?.remove("note"); research?.remove("annotations") }
        fun attachment(role: String, title: String, mime: String, data: ByteArray) {
            val hash = sha256(data); val file = File(directory, "material-$hash"); JsonFiles.write(file, data)
            materials += ZoteroMaterial(role, title, mime, file = file, sha256 = hash)
        }
        val publishedMetadata = article?.json()?.also { it.remove("html"); it.remove("markdown"); it.remove("plainText") }
        val originalRecords = publishedRecords(paper)
        attachment("source-metadata", "论文速递工作台｜来源与引用元数据", "application/json", JSONObject().put("contract", "paperdigest-source-archive-v1").put("paper", paper.json()).put("citation", article?.citation ?: paper.citation).put("publishedRecords", originalRecords).put("pdfReceipt", pdfReceipt?.copy() ?: JSONObject.NULL).put("publishedMetadata", publishedMetadata ?: JSONObject.NULL).put("articleRevisionSHA256", article?.revisionSHA256 ?: JSONObject.NULL).put("notices", JSONArray(article?.notices ?: emptyList<String>())).toString(2).toByteArray())
        if (options.optBoolean("includePDF", true)) {
            require(pdf != null && pdf.isFile) { "完整存档需要实际 PDF 原文，请先下载或关闭此项" }
            materials += ZoteroMaterial("pdf", paper.title + ".pdf", "application/pdf", file = pdf, sha256 = BackupCodec.hash(pdf))
        }
        if (options.optBoolean("includeGuide", true)) {
            require(article != null && article.paperID == paper.id && article.completeOffline) { "导读尚未完整保存全部科学图，请先完成离线保存或关闭此项" }
            attachment("guide", "论文速递工作台｜图文导读", "text/html", htmlDocument(paper.titleZh, articleBody(article), article.notices).toByteArray())
        }
        if (includeAnalysis) attachment("analysis", "论文速递工作台｜研究、原始输入与用量", "application/json", requireNotNull(research).toString(2).toByteArray())
        if (includeNote) {
            val note = store.note(paper.id)
            val annotations = store.annotations(paper.id)
            val text = note.getString("text")
            val annotationLines = annotations.groupBy { (it.optString("groupID").takeIf { group -> group.isNotBlank() } ?: it.optString("id")) to it.optString("pdfSHA") }.values.joinToString("\n") { group -> group.map { "${it.optString("text")}\n${it.optString("comment", it.optString("note"))}" }.distinct().joinToString("\n") }
            val originals = JSONObject().put("contract", "paperdigest-notes-archive-v1").put("paperID", paper.id).put("note", note).put("annotations", JSONArray(annotations))
            val html = "<div><h1>${escape(paper.titleZh)}</h1><pre>${escape(text + "\n\n" + annotationLines)}</pre><h2>原笔记与逐项批注记录</h2><pre>${escape(originals.toString(2))}</pre></div>"
            materials += ZoteroMaterial("note", "论文速递工作台｜笔记与批注", "text/html", noteHTML = html, sha256 = sha256(html.toByteArray()))
        }
        val cited = citationPaper(paper, article)
        val bibliography = JSONObject().put("itemType", if (paper.sourceKind == "arxiv") "preprint" else if (paper.id.startsWith("conference:")) "conferencePaper" else "document").put("title", cited.title)
            .put("creators", JSONArray(cited.authors.map { JSONObject().put("creatorType", "author").put("name", it) }))
            .put("date", cited.date).put("url", cited.sourceURL ?: paper.blogURL).put("abstractNote", cited.citation.nullableString("abstract") ?: article?.researchContext?.nullableString("abstract") ?: "")
            .put("extra", "PaperDigest-ID: ${paper.id}\nSource version: ${paper.sourceVersion ?: "未标注"}\nPublished guide: ${paper.blogURL}")
            .put("tags", JSONArray(paper.tags.map { JSONObject().put("tag", it) }))
        if (paper.sourceKind == "arxiv") bibliography.put("repository", "arXiv").put("archiveID", paper.sourceVersion ?: paper.id.removePrefix("arxiv:"))
        cited.citation.nullableString("doi")?.let { bibliography.put("DOI", it) }
        val sourceNotices = (if (paper.sourceKind != "local" && originalRecords.optString("status") != "verified-local-originals")
            listOf(originalRecords.optString("message", "原始目录扩展元数据尚未核验；不会将现有书目描述成完整原始元数据")) else emptyList()) +
            (if (includeAnalysis && !includeNote) listOf("未附当前笔记和批注；原解析输入保持原样，可能包含当时已经提交的文字。") else emptyList())
        return ZoteroMaterials(paper.id, sha256(canonical(paper.json()).toByteArray()), bibliography, materials, paper.sourceVersion, sourceNotices)
    }
    private suspend fun articleBody(article: Article): String = ResearchRenderer.renderArticle(context, article)
    companion object {
        fun externalDestination(context: Context, raw: String): Uri {
            val parsed = java.net.URI(raw)
            require(raw.length <= 8192 && parsed.scheme == "content" && !parsed.authority.isNullOrBlank() && parsed.userInfo == null && parsed.fragment == null) { "请通过系统文件选择器选择导出位置" }
            require(!parsed.authority.equals(context.packageName + ".files", ignoreCase = true)) { "请选择外部文档位置，不能把导出副本写回应用的临时缓存" }
            return Uri.parse(raw)
        }
        fun citationPaper(paper: Paper, article: Article?): Paper {
            ReadingSourceBinding.requireArticle(paper, article)
            val sidecar = article?.original?.optJSONObject("citationSidecar")?.let { runCatching { CatalogRepository.validatedSidecar(it, paper, false) }.getOrNull() }
            val citation = sidecar ?: article?.citation ?: paper.citation
            ReadingSourceBinding.requireCitation(paper, citation)
            val authors = citation.optJSONArray("authors")?.let { all -> (0 until all.length()).mapNotNull { index -> when (val value = all.get(index)) { is String -> value; is JSONObject -> value.opt("name") as? String; else -> null } } } ?: paper.authors
            // The catalog date is the blog date. Unknown publication dates stay unknown.
            return paper.copy(title = (citation.opt("originalTitle") as? String) ?: (citation.opt("title") as? String) ?: paper.title,
                authors = authors, date = (citation.opt("date") as? String) ?: "", sourceURL = (citation.opt("absUrl") as? String) ?: (citation.opt("sourceUrl") as? String) ?: paper.sourceURL, citation = citation.copy())
        }
        fun escape(text: String): String = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")
        internal fun htmlDocumentHead(title: String, background: Int? = null, foreground: Int? = null, link: Int? = null): String {
            require(listOf(background, foreground, link).all { it == null } || listOf(background, foreground, link).all { it != null })
            fun css(value: Int) = "#" + (value and 0xffffff).toString(16).padStart(6, '0')
            val paletteCSS = if (background == null) "" else "th{white-space:nowrap;overflow-wrap:normal;word-break:normal}td>a:only-child{display:inline-block;width:max-content;max-width:calc(100vw - 64px);max-width:min(24em,calc(100vw - 64px))}body{background:${css(background)}!important;color:${css(foreground!!)}!important}a{color:${css(link!!)}!important}blockquote{border-color:${css(link)}}"
            return "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><title>${escape(title)}</title><style>body{max-width:76ch;margin:32px auto;padding:0 22px;font:18px/1.8 system-ui,sans-serif;color:#20272c}img{max-width:100%;height:auto}table{display:block;overflow-x:auto;border-collapse:collapse}td,th{padding:8px;border:1px solid #ccd2d5}pre{overflow-x:auto;white-space:pre-wrap}math[display=block]{display:block;overflow-x:auto;margin:1.2em 0}blockquote{border-left:3px solid #547a73;padding-left:18px}h1,h2,h3{line-height:1.4;overflow-wrap:anywhere}h1{font-size:1.5em;letter-spacing:-.02em;margin:0 0 1.1em}h2{font-size:1.3em;margin:1.8em 0 .7em}h3{font-size:1.12em;margin:1.4em 0 .6em}p{margin:.85em 0}blockquote{margin:1.2em 0;padding-right:.4em}body{word-wrap:break-word}pre,table,math[display=block]{max-width:100%}@media(max-width:480px){body{margin:24px auto;padding:0 20px}h1{font-size:1.45em}}@media print{body{color:#20272c!important;background:white!important}img,figure{break-inside:avoid}tr{break-inside:avoid}}a{color:#29645a}@media(prefers-color-scheme:dark){body{color:#e3e8e6;background:#171c1c}}${paletteCSS}</style></head><body>"
        }
        fun htmlDocument(title: String, body: String, notices: List<String> = emptyList()): String =
            HtmlDocumentSegments.create(title, body, notices).joinForExport()
        fun researchMarkdown(paper: Paper, research: JSONObject): String = buildString {
            append("# ${paper.titleZh}\n\n来源：${paper.sourceURL ?: paper.blogURL}\n\n")
            research.getJSONArray("sessions").objects().forEach { s ->
                append("## ${s.optString("question")}\n\n")
                append(s.optString("answer", s.optString("text", s.optString("response")))); append("\n\n")
                append("来源与用量：\n\n```json\n${s.optJSONObject("source") ?: JSONObject()}\n${s.optJSONObject("usage") ?: JSONObject()}\n```\n\n")
            }
            append("## 阅读笔记\n\n${research.getJSONObject("note").getString("text")}\n")
        }

    }
}
