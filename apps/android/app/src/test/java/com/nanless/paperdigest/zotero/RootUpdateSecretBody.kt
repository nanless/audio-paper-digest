package com.nanless.paperdigest.zotero
import com.nanless.paperdigest.data.copy
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.secret.SecretStore
import com.nanless.paperdigest.ui.SecretKind
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
internal interface SecretActions {suspend fun updateSecret(kind:SecretKind,value:String?)}
internal class RootUpdateSecretBody(val zotero:ZoteroService,val secrets:SecretStore):SecretActions {
    data class State(val zotero:JSONObject)
    val _state=MutableStateFlow(State(zotero.state()))
    val maintenance=Mutex()
    val modelCredentialRevision=object:RevisionCounter{}
    val freshStudies=object:FreshStudies{}
    val cloud=object:Cloud{}
    val personal=object:Personal{}
    val modelKeyBinding=object:Binding{}
    var refreshes=0
    suspend fun refresh(){refreshes++;_state.update{it.copy(zotero=zotero.state())}}
    interface RevisionCounter{fun begin()=Any();fun end(token:Any){}}
    interface FreshStudies{fun invalidate(){}}
    interface Cloud{suspend fun setPassword(value:String?){error("CLOUD must not be called")}}
    interface Personal{fun settings()=JSONObject()}
    interface Binding{fun clear(){error("MODEL must not be called")};fun bind(endpoint:String){error("MODEL must not be called")}}
    override suspend fun updateSecret(kind: SecretKind, value: String?) {
        val mutation = if (kind == SecretKind.MODEL) modelCredentialRevision.begin().also { freshStudies.invalidate() } else null
        val zoteroMutation = if (kind in setOf(SecretKind.ZOTERO, SecretKind.ZOTERO_DAV)) zotero.beginCredentialMutation() else null
        try {
            if (zoteroMutation != null) _state.update { current -> current.copy(zotero = current.zotero.copy().put("credentialState", "unknown").put("permissions", JSONObject.NULL)) }
            if (zoteroMutation != null) zotero.cancelAndDrain() // Never hold maintenance while waiting for real transport cleanup.
            withContext(Dispatchers.IO) {
        when(kind) {
            SecretKind.CLOUD -> cloud.setPassword(value)
            SecretKind.MODEL -> maintenance.withLock {
                val endpoint = if (value != null) StudyService.validatedConfig(personal.settings()).getString("endpoint") else ""
                modelKeyBinding.clear()
                if (value == null) secrets.remove("model.primary") else { secrets.save("model.primary", value); modelKeyBinding.bind(endpoint) }
            }
            SecretKind.ZOTERO, SecretKind.ZOTERO_DAV -> zotero.withCredentialMutation(zoteroMutation!!) {
                maintenance.withLock {
                    zotero.requireCredentialMutation(zoteroMutation)
                    val scope = if(kind == SecretKind.ZOTERO_DAV) zotero.webdavSecretScope() else "zotero.primary"
                    if (value == null) secrets.remove(scope) else secrets.save(scope, value)
                    zotero.credentialsChanged()
                    val z = zotero.state();_state.update { it.copy(zotero = zotero.projectCredentialState(z)) }
                }
            }
        }

        refresh()
            }
        } finally {
            if (zoteroMutation != null) zotero.endCredentialMutation(zoteroMutation)
            if (mutation != null) modelCredentialRevision.end(mutation)
        }
    }
}
