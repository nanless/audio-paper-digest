package com.nanless.paperdigest.data

import java.io.InputStream

/** A native-owned, document-scoped image route. No browser network or arbitrary file access. */
interface DocumentImageAccess {
    val bodyHTML: String
    val cspImageSource: String
    fun open(url: String, isMainFrame: Boolean, method: String): Pair<String, InputStream>?
}
