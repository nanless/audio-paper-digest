package com.nanless.paperdigest.data

import org.junit.Assert.*
import org.junit.Test

class PublishedUtf8Test {
    @Test fun preservesChineseAndSupplementaryCharactersAcrossReaderBuffers() {
        val text = " ".repeat(65535) + "原文🧪𠮷与公式"
        val bytes = text.toByteArray(Charsets.UTF_8)
        assertEquals(text, PublishedUtf8.decode(bytes))
        assertEquals(text, PublishedUtf8.reader(bytes.inputStream()).use { it.readText() })
    }
    @Test fun malformedAndTruncatedUtf8CannotBecomeAChangedCatalog() {
        for (bytes in listOf(byteArrayOf(0xc3.toByte(), 0x28), byteArrayOf(0xf0.toByte(), 0x9f.toByte(), 0xa7.toByte()), byteArrayOf(0xed.toByte(), 0xa0.toByte(), 0x80.toByte()))) {
            assertTrue(runCatching { PublishedUtf8.decode(bytes) }.isFailure)
            assertTrue(runCatching { PublishedUtf8.reader(bytes.inputStream()).use { it.readText() } }.isFailure)
        }
    }
}
