package com.nanless.paperdigest.data

import java.io.InputStream
import java.io.InputStreamReader
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** The original published bytes cannot silently turn into replacement characters. */
internal object PublishedUtf8 {
    private fun decoder() = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
    fun reader(input: InputStream) = InputStreamReader(input, decoder())
    fun decode(bytes: ByteArray): String = decoder().decode(ByteBuffer.wrap(bytes)).toString()
}
