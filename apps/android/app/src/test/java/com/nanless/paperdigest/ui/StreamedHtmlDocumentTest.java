package com.nanless.paperdigest.ui;

import org.junit.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import static org.junit.Assert.*;

public class StreamedHtmlDocumentTest {
    private byte[] read(InputStream input, int chunk) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[chunk];
        for (int count; (count = input.read(buffer)) != -1;) output.write(buffer, 0, count);
        return output.toByteArray();
    }
    @Test public void utf8MatchesStandardAcrossByteAndSegmentBoundaries() throws Exception {
        String[] segments = {"<h1>中文é", "\ud83d", "", "\ude80A𝛼\u0000\ud800Z\udc00", "</h1>"};
        byte[] expected = String.join("", segments).getBytes(StandardCharsets.UTF_8);
        for (int chunk : new int[]{1, 2, 3, 4, 7, 8191, 8192, 8193})
            assertArrayEquals("read chunk " + chunk, expected, read(new SegmentedUtf8InputStream(segments), chunk));
    }
    @Test public void randomizedUnicodeIncludingMalformedSurrogatesRemainsExact() throws Exception {
        StringBuilder source = new StringBuilder(); Random random = new Random(7999);
        for (int i = 0; i < 15000; i++) source.append((char) random.nextInt(65536));
        String body = source.toString(); String[] segments = new String[body.length()];
        for (int i = 0; i < body.length(); i++) segments[i] = body.substring(i, i + 1);
        assertArrayEquals(body.getBytes(StandardCharsets.UTF_8), read(new SegmentedUtf8InputStream(segments), 5));
    }
    @Test public void inputStreamHonorsOffsetEofCloseAndInvalidBounds() throws Exception {
        SegmentedUtf8InputStream input = new SegmentedUtf8InputStream("a", "", "b");
        byte[] target = {9, 9, 9, 9}; assertEquals(2, input.read(target, 1, 2));
        assertArrayEquals(new byte[]{9, 97, 98, 9}, target);
        assertEquals(-1, input.read()); assertEquals(0, input.read(target, 0, 0));
        try { input.read(target, -1, 2); fail("bounds"); } catch (IndexOutOfBoundsException expected) { }
        input.close();
        try { input.read(); fail("closed"); } catch (IOException expected) { }
    }
    @Test public void onlyExactCurrentDocumentMainFrameGetCanBeServed() {
        StreamedHtmlDocument current = new StreamedHtmlDocument("<body>", "原正文", "</body>");
        StreamedHtmlDocument replacement = new StreamedHtmlDocument("<body>", "原正文", "</body>");
        assertNotEquals(current.getUrl(), replacement.getUrl());
        assertTrue(current.canServe(current.getUrl(), true, "GET"));
        assertFalse(current.canServe(current.getUrl(), false, "GET"));
        assertFalse(current.canServe(current.getUrl(), true, "POST"));
        for (String other : new String[]{current.getUrl() + "?x=1", current.getUrl() + "/", replacement.getUrl(),
            current.getUrl().replace("reader.invalid", "reader.invalid.evil"), "file:///etc/passwd", "content://private/secret", null})
            assertFalse("untrusted request " + other, current.canServe(other, true, "GET"));
    }
    @Test public void fragmentsStayInsideOriginalDocumentWithoutBroadOriginPermission() {
        StreamedHtmlDocument document = new StreamedHtmlDocument("", "", "");
        assertTrue(document.mayNavigateWithin(document.getUrl() + "#chapter-2"));
        assertFalse(document.mayNavigateWithin(document.getUrl() + "?redirect=https://evil.invalid"));
        assertFalse(document.mayNavigateWithin("https://reader.invalid/"));
        assertFalse(document.mayNavigateWithin("https://user@reader.invalid/"));
        assertFalse(document.mayNavigateWithin("https://reader.invalid.evil/"));
    }
    @Test public void originalBodyIdentityAndScientificBytesSurviveRepeatedOpen() throws Exception {
        String body = "<figure><img src='data:image/png;base64,AAAA'><figcaption>原图注</figcaption></figure><math><mi>𝛼</mi></math><table><tr><td>原表</td></tr></table>";
        StreamedHtmlDocument document = new StreamedHtmlDocument("<html><body>", body, "</body></html>");
        assertSame(body, document.getBodyForInspection());
        assertTrue(document.containsBodyText("原图注"));
        byte[] expected = ("<html><body>" + body + "</body></html>").getBytes(StandardCharsets.UTF_8);
        assertArrayEquals(expected, read(document.openStream(), 11));
        assertArrayEquals(expected, read(document.openStream(), 7));
    }
    @Test public void largeImmutableBodyStreamsToExactIndependentDigest() throws Exception {
        String body = "x".repeat(2_600_000); String head = "<body>", tail = "</body>";
        MessageDigest expected = MessageDigest.getInstance("SHA-256");
        expected.update(head.getBytes(StandardCharsets.UTF_8));
        byte[] repeated = new byte[2600]; Arrays.fill(repeated, (byte)'x');
        for (int i = 0; i < 1000; i++) expected.update(repeated);
        expected.update(tail.getBytes(StandardCharsets.UTF_8));
        MessageDigest actual = MessageDigest.getInstance("SHA-256"); long length = 0;
        try (InputStream input = new StreamedHtmlDocument(head, body, tail).openStream()) {
            byte[] buffer = new byte[4093]; for (int count; (count = input.read(buffer)) != -1;) { actual.update(buffer, 0, count); length += count; }
        }
        assertEquals(head.length() + 2_600_000L + tail.length(), length);
        assertArrayEquals(expected.digest(), actual.digest());
    }
}
