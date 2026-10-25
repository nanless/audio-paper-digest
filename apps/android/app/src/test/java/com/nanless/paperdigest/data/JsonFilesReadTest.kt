package com.nanless.paperdigest.data

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.nio.file.Files

class JsonFilesReadTest {
    @Test fun regularFilesPreserveExactBytesAtBufferBoundariesAndLimits() {
        val root = Files.createTempDirectory("exact-file-read-").toRealPath().toFile()
        try {
            for (size in listOf(0, 1, 32767, 32768, 32769, 1048576)) {
                val expected = ByteArray(size) { (it % 251).toByte() }; val file = root.resolve("fixture-$size")
                file.writeBytes(expected)
                assertArrayEquals(expected, JsonFiles.read(file, size.toLong()))
                assertArrayEquals(expected, file.readBytes())
                if (size > 0) assertTrue(runCatching { JsonFiles.read(file, size - 1L) }.isFailure)
            }
            assertTrue(runCatching { JsonFiles.read(root) }.isFailure)
            val link = root.resolve("link"); Files.createSymbolicLink(link.toPath(), root.resolve("fixture-1").toPath())
            assertTrue(runCatching { JsonFiles.read(link) }.isFailure)
        } finally { root.deleteRecursively() }
    }
    @Test fun concurrentSizeChangesAreRejectedInsteadOfTruncatedOrZeroPadded() {
        assertTrue(runCatching { JsonFiles.readKnownLength(byteArrayOf(1).inputStream(), 2, 2) }.isFailure)
        assertTrue(runCatching { JsonFiles.readKnownLength(byteArrayOf(1, 2).inputStream(), 1, 2) }.isFailure)
        assertTrue(runCatching { JsonFiles.readKnownLength(byteArrayOf(1).inputStream(), -1, 2) }.isFailure)
        assertTrue(runCatching { JsonFiles.readKnownLength(byteArrayOf(1).inputStream(), 1, 0) }.isFailure)
        assertTrue(runCatching { JsonFiles.readKnownLength(byteArrayOf(1).inputStream(), Int.MAX_VALUE.toLong() + 1, Long.MAX_VALUE) }.isFailure)
    }
    @Test fun shortAndZeroLengthReadsStillMakeProgressWithoutASecondFullBuffer() {
        val expected = ByteArray(65537) { (it % 251).toByte() }
        var zero = true
        val input = object : ByteArrayInputStream(expected) {
            override fun read(bytes: ByteArray, offset: Int, count: Int): Int {
                zero = !zero
                return if (zero) 0 else super.read(bytes, offset, minOf(count, 7))
            }
        }
        assertArrayEquals(expected, JsonFiles.readKnownLength(input, expected.size.toLong(), expected.size.toLong()))
    }
    @Test fun readFailureRetainsItsFailureRatherThanReturningAPartialSuccess() {
        val failure = IOException("synthetic read interruption")
        val input = object : java.io.InputStream() {
            override fun read(): Int = throw failure
            override fun read(bytes: ByteArray, offset: Int, count: Int): Int = throw failure
        }
        assertSame(failure, runCatching { JsonFiles.readKnownLength(input, 10, 10) }.exceptionOrNull())
    }
}
