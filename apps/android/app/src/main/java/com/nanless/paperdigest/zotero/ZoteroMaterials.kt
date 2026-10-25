package com.nanless.paperdigest.zotero

import org.json.JSONObject
import java.io.File

/** Prepared by the controller from actual source-bound files, never UI file paths. */
data class ZoteroMaterials(
    val paperID: String,
    val identity: String,
    val bibliography: JSONObject,
    val materials: List<ZoteroMaterial>,
    val sourceVersion: String? = null,
    val notices: List<String> = emptyList(),
)

data class ZoteroMaterial(
    val role: String,
    val title: String,
    val contentType: String,
    val file: File? = null,
    val noteHTML: String? = null,
    val sha256: String,
)

fun interface ZoteroMaterialProvider {
    suspend fun prepare(options: JSONObject): ZoteroMaterials
}
