package com.nanless.paperdigest.ui;

import java.io.IOException;
import java.io.InputStream;

/** Encodes immutable string segments with a bounded byte buffer, without a whole-document copy. */
public final class SegmentedUtf8InputStream extends InputStream {
    private String[] segments;
    private int segmentIndex;
    private int characterIndex;
    private final byte[] buffer = new byte[8192];
    private int position;
    private int limit;
    private boolean closed;

    public SegmentedUtf8InputStream(String... segments) {
        this.segments = segments.clone();
        for (String segment : this.segments) if (segment == null) throw new NullPointerException("segment");
    }

    private int peekCharacter() {
        while (segmentIndex < segments.length && characterIndex == segments[segmentIndex].length()) {
            segmentIndex++;
            characterIndex = 0;
        }
        return segmentIndex == segments.length ? -1 : segments[segmentIndex].charAt(characterIndex);
    }

    private int takeCharacter() {
        int value = peekCharacter();
        if (value >= 0) characterIndex++;
        return value;
    }

    private boolean fill() throws IOException {
        if (closed) throw new IOException("Stream closed");
        position = 0;
        limit = 0;
        while (limit <= buffer.length - 4) {
            int codePoint = takeCharacter();
            if (codePoint < 0) break;
            if (Character.isHighSurrogate((char) codePoint)) {
                int low = peekCharacter();
                if (low >= 0 && Character.isLowSurrogate((char) low)) {
                    takeCharacter();
                    codePoint = Character.toCodePoint((char) codePoint, (char) low);
                } else codePoint = '?'; // Matches the standard UTF-8 encoder's malformed-input replacement.
            } else if (Character.isLowSurrogate((char) codePoint)) codePoint = '?';
            if (codePoint < 0x80) buffer[limit++] = (byte) codePoint;
            else if (codePoint < 0x800) {
                buffer[limit++] = (byte) (0xc0 | codePoint >>> 6);
                buffer[limit++] = (byte) (0x80 | codePoint & 0x3f);
            } else if (codePoint < 0x10000) {
                buffer[limit++] = (byte) (0xe0 | codePoint >>> 12);
                buffer[limit++] = (byte) (0x80 | codePoint >>> 6 & 0x3f);
                buffer[limit++] = (byte) (0x80 | codePoint & 0x3f);
            } else {
                buffer[limit++] = (byte) (0xf0 | codePoint >>> 18);
                buffer[limit++] = (byte) (0x80 | codePoint >>> 12 & 0x3f);
                buffer[limit++] = (byte) (0x80 | codePoint >>> 6 & 0x3f);
                buffer[limit++] = (byte) (0x80 | codePoint & 0x3f);
            }
        }
        return limit > 0;
    }

    @Override public int read() throws IOException {
        if (closed) throw new IOException("Stream closed");
        if (position == limit && !fill()) return -1;
        return buffer[position++] & 0xff;
    }

    @Override public int read(byte[] target, int offset, int length) throws IOException {
        if (target == null) throw new NullPointerException("target");
        if (offset < 0 || length < 0 || offset > target.length - length) throw new IndexOutOfBoundsException();
        if (closed) throw new IOException("Stream closed");
        if (length == 0) return 0;
        int copied = 0;
        while (copied < length) {
            if (position == limit && !fill()) break;
            int count = Math.min(length - copied, limit - position);
            System.arraycopy(buffer, position, target, offset + copied, count);
            position += count;
            copied += count;
        }
        return copied == 0 ? -1 : copied;
    }

    @Override public int available() throws IOException {
        if (closed) throw new IOException("Stream closed");
        return limit - position;
    }

    @Override public void close() {
        closed = true;
        segments = new String[0];
        segmentIndex = characterIndex = position = limit = 0;
    }
}
