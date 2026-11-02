package com.nanless.paperdigest.ui

import org.junit.Assert.*
import org.junit.Test

class ReaderDocumentStyleTest {
 @Test fun phoneBaselineAndSystemScaleRemainIndependent(){
  assertEquals(100,readerTextZoom(18,1f));assertEquals(200,readerTextZoom(18,2f))
  assertEquals(333,readerTextZoom(30,2f));assertEquals(600,readerTextZoom(54,2f))
  val head=readerDocumentHead(0xfffafafa.toInt(),0xff202020.toInt(),0xff004488.toInt())
  assertTrue(head.contains("font:16px/1.65"));assertTrue(head.contains("padding:0 14px"))
  assertTrue(head.contains("table{display:block;max-width:100%;overflow-x:auto"))
  assertTrue(head.contains("h1{font-size:1.4em"));assertTrue(head.contains("overflow-wrap:anywhere"))
  assertEquals("All reading CSS blocks must be closed",head.count{it=='{'},head.count{it=='}'})
 }
 @Test fun readingShellGrantsOnlyTheSelectedImageOrigin(){
  val source="https://images.invalid/owned-scope"
  val head=readerDocumentHead(0,0,0,source)
  assertTrue(head.contains("default-src 'none'; img-src $source; font-src data:"))
  assertTrue(head.contains("base-uri 'none'; form-action 'none'"))
  assertFalse(head.contains("script-src"));assertFalse(head.contains("<script"))
 }
}
