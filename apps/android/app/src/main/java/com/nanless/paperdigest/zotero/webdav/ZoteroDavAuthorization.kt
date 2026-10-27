package com.nanless.paperdigest.zotero.webdav

/** Native request capability. A saved choice or a journal cannot construct its authority. */
interface ZoteroDavAuthorization {
    fun requireCurrent(target: ZoteroDavTarget)
    fun requirePublished(target:ZoteroDavTarget) { requireCurrent(target) }
    fun authorization(target: ZoteroDavTarget, check: () -> Unit): String
}
