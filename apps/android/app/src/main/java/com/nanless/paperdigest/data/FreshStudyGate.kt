package com.nanless.paperdigest.data

import java.util.UUID

/** In-memory mutation identity, independent of secret contents and never persisted. */
internal class ModelCredentialRevision {
    class Mutation internal constructor()
    private val active = HashSet<Mutation>()
    private var revision = UUID.randomUUID().toString()
    @Synchronized fun begin(): Mutation {
        val mutation = Mutation()
        active.add(mutation)
        revision = UUID.randomUUID().toString()
        return mutation
    }
    @Synchronized fun end(expected: Mutation) { active.remove(expected) }
    @Synchronized fun ready(): String {
        require(active.isEmpty()) { "模型密钥正在更改，请完成后重新确认。" }
        return revision
    }
}

internal data class FreshStudyStamp(val workspace: String, val credential: String, val owner: String?, val material: String,
    val pdfSHA: String?, val page: Int?, val selection: Any?, val config: String, val draft: String) {
    override fun toString() = "FreshStudyStamp[redacted]"
}

/** Only the controller's private instance owns confirmations; copied UI JSON cannot create one. */
internal class FreshStudyGate<T> {
    class Intent<T> internal constructor(val id: String, val stamp: FreshStudyStamp, val value: T)
    private var current: Intent<T>? = null
    @Synchronized fun prepare(stamp: FreshStudyStamp, value: T): Intent<T> = Intent(UUID.randomUUID().toString(), stamp, value).also { current = it }
    @Synchronized fun peek(id: String): Intent<T> = current?.takeIf { it.id == id } ?: error("本次确认已失效，请重新准备。")
    @Synchronized fun consume(id: String, stamp: FreshStudyStamp): Intent<T> {
        val intent = peek(id)
        require(intent.stamp == stamp) { "研究材料、问题或模型连接已变化，请重新确认。" }
        current = null
        return intent
    }
    @Synchronized fun discard(id: String): Boolean = if (current?.id == id) { current = null; true } else false
    @Synchronized fun invalidate() { current = null }
}
