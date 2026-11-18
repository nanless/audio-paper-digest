package com.nanless.paperdigest

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.cloud.CloudCredentialBinding
import com.nanless.paperdigest.cloud.CloudCredentialBorrowing
import com.nanless.paperdigest.cloud.CloudDavGrant
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.PdfDocumentRef
import com.nanless.paperdigest.zotero.ZoteroMaterialProvider
import com.nanless.paperdigest.zotero.ZoteroMaterials
import com.nanless.paperdigest.zotero.ZoteroService
import com.nanless.paperdigest.zotero.webdav.ZoteroDavTarget
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal data class PreparedReading(
    val token: String,
    val paperID: String,
    val options: JSONObject,
    val roles: String,
)

internal class ReadingRequest(
    val paper: Paper,
    val article: Article?,
    val offline: OfflineStore.Opened?,
    val document: PdfDocumentRef?,
    val receipt: JSONObject,
    val token: String,
) {
    @Volatile var authorization: PreparedReading? = null
}

/** Coordinates Zotero archive material sealing, role-identity verification, and borrowed WebDAV storage migrations. */
internal class ZoteroCoordinator(
    private val personal: PersonalStore,
    private val offline: OfflineStore,
    private val cloudCredentialBorrowing: CloudCredentialBorrowing,
    private val maintenance: () -> Mutex,
    private val currentEpoch: () -> String,
    private val requireCurrentEpoch: (String) -> Unit,
    private val currentCloudBinding: () -> CloudCredentialBinding,
    private val currentReadingToken: () -> String,
    private val prepareOfflineArticle: (Article) -> Article,
    private val downloadPDF: suspend (Paper) -> Pair<File, String>,
    private val pdfReceipt: (String) -> JSONObject,
    private val buildMaterials: suspend (Paper, Article?, File?, JSONObject, JSONObject) -> ZoteroMaterials,
) {
    private data class MigrationConsent(
        val grant: CloudDavGrant,
        val binding: CloudCredentialBinding,
        val epoch: String,
        val target: ZoteroDavTarget,
    )

    private val readingRequests = ConcurrentHashMap<String, ReadingRequest>()
    private val preparedReadings = ConcurrentHashMap<String, PreparedReading>()
    private val migrationConsents = ConcurrentHashMap<String, MigrationConsent>()

    fun materialProvider(): ZoteroMaterialProvider = ZoteroMaterialProvider { options ->
        maintenance().withLock {
            val bound = readingRequests[options.getString("readingRequestID")]
                ?: error("存档准备已失效，请重新核验当前阅读材料")
            require(currentReadingToken() == bound.token) { "阅读材料已变化，未把新来源加入原准备请求" }
            val old = bound.offline?.let { offline.open(it.id) }
            val paper = bound.paper
            val article = bound.article?.let(prepareOfflineArticle)
            ReadingSourceBinding.requireArticle(paper, article)
            var receipt = bound.receipt.copy()
            val original = if (options.optBoolean("includePDF", true)) {
                if (old != null) {
                    old.pdfFile ?: error("此原离线快照没有包含 PDF，未自动换成网站另一版本")
                } else if (bound.document != null) {
                    val file = File(bound.document.localPath)
                    require(BackupCodec.hash(file) == bound.document.sha256) { "当前阅读的 PDF 原件已变化" }
                    ReadingSourceBinding.requirePDF(paper, receipt, bound.document.sha256)
                    file
                } else {
                    val saved = downloadPDF(paper)
                    receipt = pdfReceipt(paper.id)
                    ReadingSourceBinding.requirePDF(paper, receipt, saved.second)
                    saved.first
                }
            } else null
            require(currentReadingToken() == bound.token) { "准备期间阅读材料已变化，原封存材料保留，请重新核验" }
            val materials = buildMaterials(paper, article, original, options, receipt)
            bound.authorization = PreparedReading(
                bound.token,
                paper.id,
                options.copy(),
                ReadingSourceBinding.selectedRoleIdentity(personal.snapshot(), paper.id, options)
            )
            materials
        }
    }

    fun workspaceRestored(zotero: ZoteroService) {
        migrationConsents.clear()
        zotero.workspaceRestored()
        preparedReadings.clear()
    }

    fun zoteroPresentation(zotero: ZoteroService, snapshot: JSONObject = personal.snapshot()): JSONObject =
        zotero.state().copy().also { state ->
            state.optJSONObject("prepared")?.let { preview ->
                val authorization = preparedReadings[preview.optString("preparedID")]
                preview.put("readingMaterialID", authorization?.token ?: JSONObject.NULL)
                val actual = if (authorization == null) null else try {
                    ReadingSourceBinding.selectedRoleIdentity(snapshot, authorization.paperID, authorization.options)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    null
                }
                preview.put("materialsCurrent", authorization != null && actual != null && authorization.roles == actual)
                if (authorization != null && actual == null) {
                    preview.put("materialChangeMessage", "所选私人材料暂时无法完整核验，请分组后重新准备；原材料和断点保留。")
                }
            }
        }

    fun retireBorrowedMigrationViews(zotero: ZoteroService, publishZoteroState: ((JSONObject) -> JSONObject) -> Unit) {
        migrationConsents.clear()
        zotero.revokeBorrowedStorageMigrations()
        publishZoteroState { current -> zotero.projectCredentialState(current) }
    }

    private fun requireMigrationConsent(consent: MigrationConsent) {
        requireCurrentEpoch(consent.epoch)
        require(currentCloudBinding() == consent.binding) { "坚果云连接已变化，请重新确认" }
        consent.grant.requireCurrent(consent.target)
    }

    suspend fun executeMigrationCommand(
        command: String,
        payload: JSONObject,
        zotero: ZoteroService,
        hasActiveTasks: () -> Boolean,
        runTask: suspend (String, () -> Unit, suspend () -> JSONObject) -> JSONObject,
    ): JSONObject = when (command) {
        "zotero.migration.preview" -> {
            val binding = currentCloudBinding()
            require(binding.account.isNotBlank()) { "请先连接坚果云" }
            val epoch = currentEpoch()
            val id = zotero.beginStorageMigrationPreview(payload.getString("journalID"), payload.getString("davBaseURL"), binding.account)
            val target = zotero.migrationTarget(id)
            val grant = cloudCredentialBorrowing.issue(target, binding)
            val consent = MigrationConsent(grant, binding, epoch, target)
            try {
                requireMigrationConsent(consent)
                val result = runTask(command, { require(!hasActiveTasks()) { "请等当前资料任务结束后再预览" } }) {
                    zotero.previewStorageMigration(id, grant)
                }
                requireMigrationConsent(consent)
                if (migrationConsents.size >= 8) {
                    migrationConsents.values.forEach { cloudCredentialBorrowing.discardUnpublished(it.grant) }
                    migrationConsents.clear()
                }
                migrationConsents[id] = consent
                result.put("previewID", id).put("account", binding.account).put("targetRoot", target.root)
            } catch (e: Throwable) {
                cloudCredentialBorrowing.discardUnpublished(grant)
                throw e
            }
        }
        "zotero.migration.confirm" -> {
            val id = payload.getString("previewID")
            val consent = migrationConsents[id] ?: error("这次预览已失效，请重新确认")
            requireMigrationConsent(consent)
            val result = runTask(command, { require(!hasActiveTasks()) { "请等当前资料任务结束后再继续存档" } }) {
                requireMigrationConsent(consent)
                val prepared = zotero.confirmStorageMigration(id, consent.grant) { publish ->
                    maintenance().withLock {
                        requireMigrationConsent(consent)
                        currentCoroutineContext().ensureActive()
                        val published = publish()
                        cloudCredentialBorrowing.publish(consent.grant, consent.target)
                        published
                    }
                }
                requireMigrationConsent(consent)
                require(prepared.optString("status") == "prepared" && prepared.opt("migration") == true) { "迁移材料尚未准备完成" }
                zotero.execute("zotero.resume", JSONObject().put("journalID", prepared.getString("journalID")))
            }
            requireMigrationConsent(consent)
            migrationConsents.remove(id, consent)
            result
        }
        "zotero.migration.discard" -> {
            migrationConsents.remove(payload.getString("previewID"))?.let { cloudCredentialBorrowing.discardUnpublished(it.grant) }
            JSONObject().put("cancelled", true)
        }
        "zotero.migration.revoke" -> {
            JSONObject().put("revoked", true).put("message", "本次坚果云存档授权已撤销，已有材料与断点保留")
        }
        else -> error("未知存档操作")
    }

    suspend fun executeZoteroCommand(
        command: String,
        payload: JSONObject,
        materialID: String,
        ownerPaperID: String,
        zotero: ZoteroService,
        requireReadingMaterials: () -> Unit,
        freezeReading: () -> ReadingRequest,
        hasActiveTasks: () -> Boolean,
        runTask: suspend (String, String, () -> Unit, suspend () -> JSONObject) -> JSONObject,
        publishProjectedZotero: (JSONObject) -> Unit,
    ): JSONObject {
        val bound = payload.copy()
        var handle: String? = null
        if (command == "zotero.prepare") {
            require(payload.optString("readingMaterialID") == materialID) { "前台阅读材料已变化，请按当前材料重新准备" }
            val request = maintenance().withLock { freezeReading() }
            handle = UUID.randomUUID().toString()
            readingRequests[handle] = request
            bound.put("paperID", request.paper.id).put("readingRequestID", handle)
        }
        var authorization: PreparedReading? = null
        val result = try {
            if (command == "zotero.archive") maintenance().withLock {
                requireReadingMaterials()
                require(payload.optString("readingMaterialID") == materialID) { "前台存档确认属于另一阅读材料，请重新准备" }
                val confirmed = payload.getString("preparedID")
                require(!payload.has("journalID") || payload.optString("journalID") == confirmed) { "存档确认不能指定另一原断点" }
                bound.remove("journalID")
                val original = preparedReadings[confirmed]
                require(original != null && original.token == materialID) { "此预览属于另一阅读来源，请重新核验材料；原断点仍可在设置中明确续传" }
                require(original.roles == ReadingSourceBinding.selectedRoleIdentity(personal.snapshot(), original.paperID, original.options)) {
                    "所选笔记、标注或研究已经变化，请重新准备材料；原断点保留。"
                }
            }
            val actual = if (command != "zotero.state") {
                runTask(command, ownerPaperID, { require(!hasActiveTasks()) { "请等当前资料任务结束再操作 Zotero" } }) {
                    zotero.execute(command, bound)
                }
            } else {
                zotero.execute(command, bound)
            }
            if (command == "zotero.prepare") authorization = handle?.let { readingRequests[it]?.authorization }
            actual
        } finally {
            handle?.let(readingRequests::remove)
        }
        if (command == "zotero.prepare") {
            requireReadingMaterials()
            val original = authorization ?: error("准备材料未取得实际角色身份，请重新核验")
            if (preparedReadings.size >= 64) preparedReadings.clear()
            preparedReadings[result.getString("preparedID")] = original
            result.put("readingMaterialID", materialID).put(
                "materialsCurrent",
                original.roles == ReadingSourceBinding.selectedRoleIdentity(personal.snapshot(), original.paperID, original.options)
            )
        }
        val presentation = zoteroPresentation(zotero)
        publishProjectedZotero(zotero.projectCredentialState(presentation))
        return result
    }
}
