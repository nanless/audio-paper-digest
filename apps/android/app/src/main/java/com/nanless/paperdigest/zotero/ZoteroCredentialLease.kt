package com.nanless.paperdigest.zotero

import java.util.IdentityHashMap

/** Native-only handle: not a credential, hash, persisted revision or UI capability. */
class ZoteroCredentialMutation internal constructor()
internal class ZoteroCredentialSuperseded:IllegalArgumentException("Zotero 凭据或连接已变化，请重新核验")

/** One process-local revision; overlapping mutations remain unavailable until every owner finishes. */
internal class ZoteroCredentialLease {
    internal class Check internal constructor(internal val revision:Any)
    private var revision=Any()
    private val mutations=IdentityHashMap<ZoteroCredentialMutation,Boolean>()
    private data class Confirmation(val revision:Any,val target:String,val at:String)
    private var confirmation:Confirmation?=null
    @Synchronized fun beginMutation():ZoteroCredentialMutation {
        val token=ZoteroCredentialMutation();mutations[token]=true
        retire();return token
    }
    @Synchronized fun endMutation(token:ZoteroCredentialMutation){
        check(mutations.remove(token)==true){"Zotero 凭据修改句柄已失效"}
    }
    @Synchronized fun changed(){retire()}
    private fun retire(){revision=Any();confirmation=null}
    @Synchronized fun capture():Check {
        if(mutations.isNotEmpty())throw ZoteroCredentialSuperseded()
        return Check(revision)
    }
    @Synchronized fun requireCurrent(token:Check){
        if(token.revision!==revision||mutations.isNotEmpty())throw ZoteroCredentialSuperseded()
    }
    @Synchronized fun clearConfirmation(){confirmation=null}
    @Synchronized fun confirm(token:Check,target:String,at:String){
        requireCurrent(token);confirmation=Confirmation(revision,target,at)
    }
    @Synchronized fun confirmedAt(target:String):String? {
        val value=confirmation?:return null
        return value.at.takeIf{mutations.isEmpty()&&value.revision===revision&&value.target==target}
    }
    @Synchronized fun confirmedAtView(target:String):String? {
        val value=confirmation?:return null
        return value.at.takeIf{mutations.isEmpty()&&value.revision===revision&&value.target.substringAfter('\u0000')==target}
    }
}
