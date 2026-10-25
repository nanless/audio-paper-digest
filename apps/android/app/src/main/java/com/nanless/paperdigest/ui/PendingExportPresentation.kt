package com.nanless.paperdigest.ui

import org.json.JSONObject
import java.time.Instant

/** JSONObject.NULL and wrong scalar types are not user messages. Never stringify them into "null". */
internal fun pendingExportMessage(row: JSONObject): String? = (row.opt("message") as? String)?.takeIf { it.isNotBlank() }

/** Only actual creation instants order pending operations. Presentation never rewrites records or leases. */
internal fun pendingExportsNewest(rows: List<JSONObject>): List<JSONObject> = rows.withIndex()
    .sortedWith(compareByDescending<IndexedValue<JSONObject>> { indexed ->
        (indexed.value.opt("createdAt") as? String)?.let { value -> runCatching { Instant.parse(value) }.getOrNull() } ?: Instant.MIN
    }.thenBy { it.index }).map { it.value }
