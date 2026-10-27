package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.data.canonical
import com.nanless.paperdigest.zotero.webdav.ZoteroDavAuthorization
import com.nanless.paperdigest.zotero.webdav.ZoteroDavFailure
import com.nanless.paperdigest.zotero.webdav.ZoteroDavTarget
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import java.net.URI
import java.util.IdentityHashMap

/** Non-secret native owner identity. It does not contain a scope, password or password fingerprint. */
data class CloudCredentialBinding(val destinationID: String, val account: String, val folder: String)
class CloudCredentialMutation internal constructor()
class CloudDavGrant internal constructor(private val owner: CloudCredentialBorrowing) : ZoteroDavAuthorization {
    override fun requireCurrent(target: ZoteroDavTarget) = owner.requireCurrent(this, target)
    override fun requirePublished(target:ZoteroDavTarget)=owner.requirePublished(this,target)
    override fun authorization(target: ZoteroDavTarget, check: () -> Unit) = owner.authorization(this, target, check)
}

/** Process-local consent; all request authority disappears on credential/target/workspace mutation. */
class CloudCredentialBorrowing(private val workspaceEpoch: () -> String) {
    private data class Grant(
        val binding: CloudCredentialBinding, val target: String, val username: String,
        val revision: Any, val workspace: String, var published:Boolean=false,
    )
    private class Mutation(val revision: Any, val binding: CloudCredentialBinding?, val workspace: String, val hadGrants: Boolean) {
        val drained = CompletableDeferred<Unit>()
        var drainStarted = false
    }
    private val grants = IdentityHashMap<CloudDavGrant, Grant>()
    private val mutations = IdentityHashMap<CloudCredentialMutation, Mutation>()
    private var revision: Any = Any()
    private var borrowersMayNeedDrain = false
    private var bindingOwner: (() -> CloudCredentialBinding)? = null
    private var authorizationOwner: ((CloudCredentialBinding) -> String)? = null
    private var drainBorrowers: (suspend () -> Unit)? = null

    internal fun attachOwner(binding: () -> CloudCredentialBinding, authorization: (CloudCredentialBinding) -> String) = synchronized(this) {
        check(bindingOwner == null && authorizationOwner == null)
        bindingOwner = binding; authorizationOwner = authorization
    }
    internal fun attachDrain(drain: suspend () -> Unit) = synchronized(this) {
        check(drainBorrowers == null); drainBorrowers = drain
    }
    fun binding(): CloudCredentialBinding = synchronized(this) {
        bindingOwner?.invoke() ?: throw ZoteroDavFailure("stale")
    }
    private fun retire() { revision = Any(); grants.clear() }
    fun beginMutation(): CloudCredentialMutation = synchronized(this) {
        val hadGrants = borrowersMayNeedDrain; retire()
        CloudCredentialMutation().also { mutations[it] = Mutation(revision, bindingOwner?.invoke(), workspaceEpoch(), hadGrants) }
    }
    suspend fun drain(token: CloudCredentialMutation) {
        val state: Mutation; val leader: Boolean; val callback: (suspend () -> Unit)?
        synchronized(this) {
            state = mutations[token] ?: throw ZoteroDavFailure("stale")
            leader = !state.drainStarted; state.drainStarted = true; callback = drainBorrowers
        }
        if (leader) {
            try {
                if (state.hadGrants) {
                    (callback ?: throw ZoteroDavFailure("stale")).invoke()
                    synchronized(this) { borrowersMayNeedDrain = false }
                }
                state.drained.complete(Unit)
            } catch (e: Throwable) { state.drained.completeExceptionally(e); throw e }
        } else state.drained.await()
    }
    fun requireMutation(token: CloudCredentialMutation) = synchronized(this) {
        val state = mutations[token] ?: throw ZoteroDavFailure("stale")
        if (state.revision !== revision || state.workspace != workspaceEpoch() || state.binding != bindingOwner?.invoke() || !state.drained.isCompleted || state.drained.isCancelled) throw ZoteroDavFailure("stale")
    }
    fun endMutation(token: CloudCredentialMutation) = synchronized(this) {
        check(mutations.remove(token) != null) { "坚果云凭据修改句柄已失效" }
    }
    fun workspaceRestored() = synchronized(this) { retire() }
    internal fun discardUnpublished(grant: CloudDavGrant) = synchronized(this) { if(grants[grant]?.published==false)grants.remove(grant); Unit }
    internal fun publish(grant:CloudDavGrant,target:ZoteroDavTarget)=synchronized(this){current(grant,target).published=true}

    fun issue(target: ZoteroDavTarget, expected: CloudCredentialBinding): CloudDavGrant = synchronized(this) {
        if (mutations.isNotEmpty() || expected != bindingOwner?.invoke() || expected.account.isBlank() || expected.account != target.username) throw ZoteroDavFailure("stale")
        val uri = try { URI(target.root) } catch (_: Exception) { throw ZoteroDavFailure("target") }
        if (uri.scheme != "https" || uri.host != "dav.jianguoyun.com" || uri.port !in listOf(-1, 443) || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null || !uri.rawPath.startsWith("/dav/") || !uri.rawPath.endsWith("/zotero/")) throw ZoteroDavFailure("target")
        CloudDavGrant(this).also { grants[it] = Grant(expected, canonical(target.binding()), target.username, revision, workspaceEpoch()); borrowersMayNeedDrain = true }
    }
    fun requireCurrent(grant: CloudDavGrant, target: ZoteroDavTarget) = synchronized(this) { current(grant, target); Unit }
    fun requirePublished(grant:CloudDavGrant,target:ZoteroDavTarget)=synchronized(this){if(!current(grant,target).published)throw ZoteroDavFailure("permission")}
    private fun current(grant: CloudDavGrant, target: ZoteroDavTarget): Grant {
        val state = grants[grant] ?: throw ZoteroDavFailure("stale")
        if (mutations.isNotEmpty() || state.revision !== revision || state.workspace != workspaceEpoch() || state.binding != bindingOwner?.invoke() || state.target != canonical(target.binding()) || state.username != target.username) throw ZoteroDavFailure("stale")
        return state
    }
    internal fun authorization(grant: CloudDavGrant, target: ZoteroDavTarget, check: () -> Unit): String {
        check()
        val state: Grant; val authorize: (CloudCredentialBinding) -> String
        synchronized(this) { state = current(grant, target); if(!state.published)throw ZoteroDavFailure("permission"); authorize = authorizationOwner ?: throw ZoteroDavFailure("stale") }
        // Owner loads its own saved scope. Never hold this monitor across credential I/O.
        val header = try { authorize(state.binding) }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { requireCurrent(grant, target); throw ZoteroDavFailure("authentication") }
        check(); requireCurrent(grant, target)
        return header
    }
}
