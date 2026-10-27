package com.nanless.paperdigest.model;

/** fd 拥有的完整暂存与内核 no-replace 原子发布；不接收任何凭据。 */
final class CapturePublicationNative {
    static { System.loadLibrary("paperdigest_capture_publish"); }
    static native int publishNoReplace(String target, byte[] content, String nonce);
    private CapturePublicationNative() {}
}
