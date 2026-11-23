package com.nanless.paperdigest

import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.pdf.*
import com.nanless.paperdigest.ui.UiState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.concurrent.ConcurrentHashMap

internal data class ReadingAccess(
    val owner: String?,
    val generation: Long,
    val pdfSHA: String?,
    val selection: PdfSelection?,
    val pdfPage: Int,
    val materialID: String,
)

/** Pure validation rules for workbench settings mutations. */
internal object SettingsValidator {
    fun strictInteger(value: Any, min: Int, max: Int): Int {
        val number = when (value) {
            is Number -> value.toDouble().takeIf { it.isFinite() && it == value.toInt().toDouble() }?.toInt()
            is String -> value.takeIf { it.matches(Regex("[0-9]{1,9}")) }?.toIntOrNull()
            else -> null
        }
        require(number != null && number in min..max) { "数字设置超出允许范围" }
        return number
    }

    fun validate(changes: JSONObject, currentSettings: JSONObject) {
        changes.keys().forEach { key ->
            when (key) {
                "font" -> changes.put(key, strictInteger(changes.get(key), 14, 30))
                "dailyRequests" -> changes.put(key, strictInteger(changes.get(key), 1, 1000))
                "maxTokens" -> changes.put(key, strictInteger(changes.get(key), 128, 64000))
                "timeoutMs" -> changes.put(key, strictInteger(changes.get(key), 1000, 600000))
                "syncHours" -> changes.put(key, strictInteger(changes.get(key), 1, 168))
                "appearance" -> require(changes.getString(key) in listOf("system", "light", "dark"))
                "httpProxy" -> if (changes.getString(key).isNotBlank()) {
                    val u = URI(changes.getString(key))
                    require(
                        u.scheme == "http" && u.host != null && u.port in 1..65535 &&
                            u.userInfo == null && u.query == null && u.fragment == null && u.path in listOf("", "/")
                    ) { "请输入不含密码的 HTTP CONNECT 代理" }
                }
            }
        }
        val merged = currentSettings.copy()
        changes.keys().forEach { merged.put(it, changes.get(it)) }
        if (merged.optString("endpoint").isNotBlank() && merged.optString("model").isNotBlank()) {
            StudyService.validatedConfig(merged)
        }
    }
}

/** Coordinates fresh study confirmation gates, evidence extraction, and StudyService job lifecycle. */
internal class StudyCoordinator(
    private val research: File,
    private val personal: PersonalStore,
    private val model: StudyService,
    private val active: ConcurrentHashMap<String, Job>,
    private val maintenance: () -> Mutex,
    private val currentEpoch: () -> String,
    private val requireCurrentEpoch: (String) -> Unit,
    private val currentState: () -> UiState,
    private val currentReadingID: (UiState) -> String,
    private val requireReading: (ReadingAccess, Boolean) -> Unit,
    private val requireReadingMaterials: (ReadingAccess) -> Unit,
    private val selectedPaper: () -> Paper,
    private val pdfOutline: suspend (PdfDocumentRef) -> List<PdfChapter>,
    private val pdfEvidence: suspend (PdfDocumentRef, Int, Int) -> PdfEvidence,
    private val enqueueStudyWork: (String, String) -> Unit,
    private val onRefresh: () -> Unit,
) {
    private data class FreshStudyIntent(
        val check: Boolean,
        val payload: JSONObject,
        val access: ReadingAccess,
        val epoch: String,
    )

    private val modelCredentialRevision = ModelCredentialRevision()
    private val freshStudies = FreshStudyGate<FreshStudyIntent>()

    fun requireReadyCredentials() {
        modelCredentialRevision.ready()
    }

    fun beginCredentialMutation(): ModelCredentialRevision.Mutation {
        freshStudies.invalidate()
        return modelCredentialRevision.begin()
    }

    fun endCredentialMutation(token: ModelCredentialRevision.Mutation) {
        modelCredentialRevision.end(token)
    }

    fun workspaceRestored() {
        freshStudies.invalidate()
    }

    private fun freshConfigIdentity(): String {
        val settings = personal.settings()
        return canonical(
            JSONObject()
                .put("route", StudyService.validatedConfig(settings))
                .put("dailyRequests", settings.optInt("dailyRequests", 20).coerceIn(1, 1000))
                .put("offlineMode", settings.optBoolean("offlineMode"))
        )
    }

    private fun freshStudyStamp(intent: FreshStudyIntent): FreshStudyStamp {
        requireCurrentEpoch(intent.epoch)
        val current = currentState()
        val kind = intent.payload.optString("evidenceKind", "guide")
        if (!intent.check) {
            requireReadingMaterials(intent.access)
            requireReading(intent.access, kind != "guide")
            if (kind == "selection") require(intent.access.selection != null && current.pdfSelection == intent.access.selection) { "原文选区已变化，请重新确认。" }
            if (kind == "page") require(current.pdfPage == intent.access.pdfPage) { "原文物理页已变化，请重新确认。" }
        }
        return FreshStudyStamp(
            currentEpoch(),
            modelCredentialRevision.ready(),
            if (intent.check) null else intent.access.owner,
            if (intent.check) "connection-check" else currentReadingID(current),
            if (!intent.check && kind != "guide") current.pdfDocument?.sha256 else null,
            if (!intent.check && kind == "page") current.pdfPage else null,
            if (!intent.check && kind == "selection") current.pdfSelection else null,
            freshConfigIdentity(),
            canonical(intent.payload)
        )
    }

    suspend fun prepareFreshStudy(
        command: String,
        raw: JSONObject,
        access: ReadingAccess,
        expectedEpoch: String,
    ): JSONObject = maintenance().withLock {
        currentCoroutineContext().ensureActive()
        requireCurrentEpoch(expectedEpoch)
        modelCredentialRevision.ready()
        val check = command == "model.fresh.check.prepare"
        require(raw.keys().asSequence().toSet().all { it in setOf("question", "evidenceKind", "fromPage", "toPage", "chapter", "readingMaterialID") }) {
            "确认参数无效，请重新准备。"
        }
        val payload = if (check) JSONObject().put("evidenceKind", "connection-check") else raw.copy().also {
            require(raw.getString("readingMaterialID").isNotBlank() && raw.getString("readingMaterialID") == access.materialID) {
                "阅读材料已变化，请重新准备。"
            }
            it.remove("readingMaterialID")
            val question = it.getString("question")
            require(question.isNotBlank() && question.length <= 16000) { "请填写明确的研究问题。" }
            require(it.getString("evidenceKind") in listOf("guide", "selection", "page", "chapter", "range", "full")) {
                "请明确选择实际原文范围。"
            }
        }
        payload.put("force", true)
        val value = FreshStudyIntent(check, payload, access, expectedEpoch)
        val scope: String
        if (check) {
            scope = "固定最小连接检查，不包含论文、笔记或选区。"
        } else {
            requireReadingMaterials(access)
            val kind = payload.getString("evidenceKind")
            val state = currentState()
            if (kind == "guide") {
                val article = state.article ?: error("请先读取当前导读。")
                ReadingSourceBinding.requireArticle(selectedPaper(), article)
                scope = "当前导读文字与公式结构，不包含图像。"
            } else {
                requireReading(access, true)
                val doc = state.pdfDocument ?: error("请先打开原文 PDF。")
                fun integer(key: String): Int {
                    val n = payload.get(key)
                    require(n is Number && n.toDouble().isFinite() && n.toDouble() == n.toInt().toDouble()) { "请填写实际物理页。" }
                    return n.toInt()
                }
                if (kind == "selection") {
                    val selection = access.selection ?: error("请先选择实际 PDF 文字。")
                    require(selection == state.pdfSelection && selection.documentSHA256 == doc.sha256 && selection.text.isNotBlank())
                    require(selection.pages.isNotEmpty() && selection.pages.all { it in 1..doc.pageCount }) { "物理页范围无效。" }
                    scope = "原 PDF 当前选区，物理页 " + selection.pages.distinct().sorted().joinToString(", ") + " 的文字，不包含图像。"
                } else {
                    val range = when (kind) {
                        "page" -> access.pdfPage to access.pdfPage
                        "full" -> 1 to doc.pageCount
                        "chapter" -> {
                            val entries = pdfOutline(doc)
                            val index = integer("chapter")
                            require(index in entries.indices) { "请选择原 PDF 中实际存在的章节。" }
                            entries[index].page to entries[index].endPage
                        }
                        else -> integer("fromPage") to integer("toPage")
                    }
                    require(range.first in 1..doc.pageCount && range.second in range.first..doc.pageCount) { "物理页范围无效。" }
                    scope = "原 PDF 物理页 ${range.first}–${range.second} 的文字，不包含图像。"
                }
            }
        }
        val stamp = freshStudyStamp(value)
        currentCoroutineContext().ensureActive()
        val intent = freshStudies.prepare(stamp, value)
        JSONObject()
            .put("confirmationID", intent.id)
            .put("kind", if (check) "connection-check" else "study")
            .put("draftIdentity", sha256(canonical(payload).toByteArray()))
            .put("question", if (check) "检查当前模型连接" else payload.getString("question"))
            .put("scope", scope)
            .put("model", StudyService.validatedConfig(personal.settings()).getString("model"))
            .put("notice", "确认后将另建一次请求并可能产生费用；原研究记录、原回答和已产生用量保留。")
    }

    suspend fun commitFreshStudy(payload: JSONObject): JSONObject = maintenance().withLock {
        val id = payload.getString("confirmationID")
        val intent = freshStudies.peek(id)
        try {
            val operation = currentCoroutineContext()
            val currentStamp = freshStudyStamp(intent.value)
            require(payload.getString("draftIdentity") == sha256(canonical(intent.value.payload).toByteArray())) {
                "问题或范围已变化，请重新确认。"
            }
            val confirmed = freshStudies.consume(id, currentStamp)
            prepareStudyLocked(
                if (confirmed.value.check) "model.check" else "model.run",
                confirmed.value.payload.copy(),
                confirmed.value.access
            ) {
                operation.ensureActive()
                require(freshStudyStamp(confirmed.value) == confirmed.stamp) {
                    "研究材料或模型连接已变化，请重新确认。"
                }
            }
        } catch (failure: Throwable) {
            freshStudies.discard(id)
            throw failure
        }
    }

    suspend fun discardFreshStudy(confirmationID: String): JSONObject = maintenance().withLock {
        JSONObject().put("cancelled", freshStudies.discard(confirmationID))
    }

    suspend fun prepareStudy(command: String, payload: JSONObject, access: ReadingAccess): JSONObject =
        maintenance().withLock {
            prepareStudyLocked(command, payload, access)
        }

    private suspend fun prepareStudyLocked(
        command: String,
        payload: JSONObject,
        access: ReadingAccess,
        extraGuard: () -> Unit = {},
    ): JSONObject {
        extraGuard()
        val evidenceKind = payload.optString("evidenceKind", "guide")
        if (command != "model.check") requireReading(access, evidenceKind != "guide")
        if (command != "model.check" && evidenceKind == "selection") {
            require(access.selection != null && currentState().pdfSelection == access.selection) {
                "原文选区已经变化，旧问题没有采用另一段文字"
            }
        }
        if (command != "model.check" && evidenceKind == "page") {
            require(currentState().pdfPage == access.pdfPage) { "原文物理页已经变化，旧问题没有采用另一页" }
        }
        val p = if (command == "model.check") null else selectedPaper()
        val source = JSONObject()
            .put("paperID", p?.id ?: "configuration-check")
            .put("sourceVersion", p?.sourceVersion ?: "")
            .put("sourceURL", p?.sourceURL ?: p?.blogURL ?: "")
        val evidence: String
        if (p == null) {
            evidence = "这是一项最小连接检查，不包含论文或私人资料。"
            source.put("kind", "connection-check").put("extractor", "fixed-check")
        } else {
            val state = currentState()
            when (val kind = payload.optString("evidenceKind", "guide")) {
                "guide" -> {
                    val a = state.article
                    require(a != null && a.paperID == p.id) { "请先读取当前导读" }
                    ReadingSourceBinding.requireArticle(p, a)
                    evidence = if (a.markdown != null || a.html.isBlank()) a.plainText
                    else CatalogRepository.articlePlainText(org.jsoup.Jsoup.parseBodyFragment(a.html).body())
                    source.put("sourceVersion", a.sourceVersion ?: "")
                        .put("sourceURL", a.sourceURL)
                        .put("kind", "published-guide")
                        .put("revision", a.revisionSHA256)
                        .put("isStale", a.isStale)
                        .put("includesImages", false)
                        .put("notices", JSONArray(a.notices + "本次仅采用导读文字与公式结构，不包含科学图的像素内容。"))
                        .put("extractor", if (a.markdown != null) "published-markdown" else a.mathMLContract ?: "legacy-published-html-unverified")
                }
                "selection" -> {
                    val selection = access.selection ?: error("请先在 PDF 中选择实际文字")
                    val d = state.pdfDocument ?: error("PDF 尚未打开")
                    require(selection.documentSHA256 == d.sha256 && selection.text.isNotBlank())
                    evidence = selection.text
                    source.put("kind", "pdf-selection")
                        .put("pages", JSONArray(selection.pages))
                        .put("pdfSHA", d.sha256)
                        .put("extractor", selection.extractor)
                }
                "page", "range", "full", "chapter" -> {
                    val d = state.pdfDocument ?: error("请先打开 PDF")
                    val chapter = if (kind == "chapter") {
                        val entries = pdfOutline(d)
                        val index = payload.getInt("chapter")
                        require(index in entries.indices) { "请选择原 PDF 中实际存在的目录章节；没有目录时请使用页段" }
                        entries[index]
                    } else null
                    val from = when (kind) {
                        "full" -> 1
                        "page" -> access.pdfPage
                        "chapter" -> chapter!!.page
                        else -> payload.getInt("fromPage")
                    }
                    val to = when (kind) {
                        "full" -> d.pageCount
                        "page" -> from
                        "chapter" -> chapter!!.endPage
                        else -> payload.getInt("toPage")
                    }
                    val e = pdfEvidence(d, from, to)
                    require(e.missingTextPages.size < e.pages.size) { "这些页面没有可提取文字，不能将空文本当完整论文分析" }
                    evidence = e.text
                    source.put("kind", e.kind)
                        .put("pages", JSONArray(e.pages))
                        .put("missingTextPages", JSONArray(e.missingTextPages))
                        .put("allPagesHaveExtractableText", e.missingTextPages.isEmpty())
                        .put("includesImages", false)
                        .put("textExtractionNotice", "本次为原PDF文字提取，不含图像；部分数学字体或版面可能无法完整映射，请核对原PDF。")
                        .put("pdfSHA", d.sha256)
                        .put("extractor", "android-pdfbox-physical-pages")
                    chapter?.let { source.put("kind", "pdf-chapter").put("chapter", it.index).put("chapterTitle", it.title) }
                }
                else -> error("证据范围尚不支持")
            }
            if (payload.optString("evidenceKind", "guide") != "guide") {
                val actual = state.pdfReceipt
                require(actual.optString("paperID", p.id) == p.id && actual.optString("sha256") == state.pdfDocument?.sha256) {
                    "PDF 来源回执与实际已开原件不符"
                }
                source.put("sourceVersion", actual.nullableString("version") ?: "")
                    .put("sourceURL", actual.optString("sourceURL"))
                    .put("isStale", actual.optBoolean("isStale"))
                    .put("currentness", actual.optString("currentness", "unknown"))
                    .put("notices", actual.optJSONArray("notices") ?: JSONArray())
                source.put("includesImages", false)
                    .put("textExtractionNotice", "本次为PDF实际文字，不含图像；数学字体与版面提取可能存在局限，请核对原件。")
            }
        }
        if (command != "model.check") requireReading(access, evidenceKind != "guide")
        if (command != "model.check" && evidenceKind == "selection") {
            require(currentState().pdfSelection == access.selection) { "提取期间选区已经变化，未派发请求" }
        }
        if (command != "model.check" && evidenceKind == "page") {
            require(currentState().pdfPage == access.pdfPage) { "提取期间物理页已经变化，未派发请求" }
        }
        extraGuard()
        val prepared = model.prepare(
            p?.id ?: "configuration-check",
            if (command == "model.check") "请只回复连接成功。" else payload.getString("question"),
            evidence,
            source,
            payload.optBoolean("force")
        )
        try {
            if (command != "model.check") requireReading(access, evidenceKind != "guide")
            extraGuard()
        } catch (e: Exception) {
            if (!prepared.optBoolean("reused")) {
                personal.appendSession(
                    prepared.copy().put("status", "cancelled").put(
                        "error",
                        if (command == "model.check") "准备期间模型连接变化，未派发请求"
                        else "准备期间阅读上下文变化，未派发请求"
                    )
                )
            }
            throw e
        }
        if (prepared.optBoolean("reused")) return prepared
        val id = prepared.getString("id")
        personal.upsertJob(
            JSONObject()
                .put("id", id)
                .put("kind", command)
                .put("paperID", p?.id.orEmpty())
                .put("status", "queued")
                .put("createdAt", now())
                .put("message", "等待系统执行；未发出的请求不会产生模型用量")
        )
        enqueueStudyWork(id, currentEpoch())
        return prepared.put("queued", true)
    }

    suspend fun performStudy(id: String, workspaceEpoch: String) {
        val job = currentCoroutineContext()[Job]!!
        val row = maintenance().withLock {
            requireCurrentEpoch(workspaceEpoch)
            val original = personal.snapshot().getJSONArray("jobs").objects()
                .firstOrNull { it.optString("id") == id }?.copy() ?: error("原研究调度不存在")
            personal.upsertJob(original.put("status", "running").put("startedAt", now()))
            active[id] = job
            original
        }
        try {
            onRefresh()
            val result = model.run(id)
            withContext(NonCancellable) {
                maintenance().withLock {
                    personal.upsertJob(
                        studyJob(row, result).put("status", "completed").put("endedAt", now())
                            .put("message", "研究已完成，原始输入、回答和用量已保存")
                    )
                }
            }
        } catch (e: Exception) {
            withContext(NonCancellable) {
                maintenance().withLock {
                    personal.upsertJob(
                        studyJob(row, personal.session(id))
                            .put("status", if (e is CancellationException) "cancelled" else "failed")
                            .put("endedAt", now())
                            .put("message", "研究未完成；可能已有实际消费，请检查记录，未自动重发")
                    )
                }
            }
            throw e
        } finally {
            active.remove(id)
            onRefresh()
        }
    }

    suspend fun recoverSavedStudy(id: String): JSONObject = maintenance().withLock {
        require(active.isEmpty()) { "请待当前任务结束再核验原保存回答" }
        val result = model.recoverSaved(id)
        personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id }?.let { original ->
            personal.upsertJob(
                studyJob(original, result)
                    .put("status", "completed")
                    .put("endedAt", result.getString("endedAt"))
                    .put("message", "已核验原保存回答；未读取 API 密钥，未重新发出请求")
            )
        }
        result
    }

    fun studyJob(job: JSONObject, session: JSONObject?): JSONObject {
        if (session == null) return job
        val result = job.copy()
        listOf("usage", "actualModel", "model", "requestIssued", "charge", "costKnown").forEach {
            if (session.has(it)) result.put(it, session.get(it))
        }
        result.put(
            "material",
            JSONObject()
                .put("kind", session.optJSONObject("source")?.optString("kind") ?: "研究输入")
                .put("createdAt", session.optString("createdAt"))
                .put("sha256", session.optString("inputSHA256"))
        )
        return result
    }

    /** Never use PersonalStore.session's first-match lookup for a navigation capability. */
    fun originalStudySession(id: String): JSONObject {
        val sessions = personal.snapshot().getJSONArray("sessions").objects().filter { it.opt("id") == id }
        require(sessions.size == 1) { "原研究不存在或身份重复，未选择另一条记录" }
        return sessions.single()
    }

    fun requireSavedStudySource(id: String): SavedStudySource =
        readSavedStudyInput(originalStudySession(id), research)
            ?: error("原研究的实际封存输入、已声明保存的响应材料、来源身份或原 PDF 页码无法核验，未采用摘要或当前版本替代")
}
