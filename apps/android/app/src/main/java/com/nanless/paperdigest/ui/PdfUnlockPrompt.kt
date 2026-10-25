package com.nanless.paperdigest.ui

/** Non-secret display state. No password, file path or native session capability. */
data class PdfUnlockPrompt(val requestID:String,val displayName:String,val purpose:String,
    val message:String?=null,val checking:Boolean=false,val stopping:Boolean=false)
