package com.nanless.paperdigest.ui;

import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.UUID;

/** One immutable local document; no URL, file, or process-global resource registry. */
public final class StreamedHtmlDocument {
    private final String head;
    private final String body;
    private final String tail;
    private final String url = "https://reader.invalid/document/" + UUID.randomUUID();

    public StreamedHtmlDocument(String head, String body, String tail) {
        if (head == null || body == null || tail == null) throw new NullPointerException("document segment");
        this.head = head;
        this.body = body;
        this.tail = tail;
    }

    public String getUrl() { return url; }
    /** Read-only test/inspection hint; actual load completion still requires the rendered DOM. */
    public boolean containsBodyText(String needle) { return needle != null && body.contains(needle); }
    public String getBodyForInspection() { return body; }
    public InputStream openStream() { return new SegmentedUtf8InputStream(head, body, tail); }
    public boolean canServe(String requestedUrl, boolean isMainFrame, String method) {
        return isMainFrame && "GET".equals(method) && url.equals(requestedUrl);
    }
    public boolean mayNavigateWithin(String destination) {
        if (destination == null) return false;
        try {
            URI uri = new URI(destination);
            return uri.getRawQuery() == null && url.equals(new URI(uri.getScheme(), uri.getRawAuthority(), uri.getRawPath(), null, null).toString());
        } catch (URISyntaxException invalid) { return false; }
    }
}
