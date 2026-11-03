package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.protocols.ClientProtocols
import org.json.JSONObject

internal object ZoteroJournalFormats {
    const val journal = "paperdigest-zotero-web"
    private const val plan = "paperdigest-zotero-plan"

    fun planHeader(originalJournal: JSONObject? = null): JSONObject {
        if (originalJournal == null) return ClientProtocols.record(plan)
        require(ClientProtocols.hasValidHeader(originalJournal, journal))
        val fingerprint = originalJournal.opt("schemaFingerprint") as? String
        if (fingerprint == null) {
            return ClientProtocols.historicalHeader(plan, "bound-zotero-target-and-original-materials", null)
        }
        val declared = ClientProtocols.declaredSchema(originalJournal.get("contract"), journal, fingerprint)
            .getJSONObject("planFormat")
        require(ClientProtocols.hasValidHeader(declared, plan))
        return ClientProtocols.recordHeader(declared.get("contract"), plan, declared.opt("schemaFingerprint") as? String)
    }
}
