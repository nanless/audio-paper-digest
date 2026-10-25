package com.nanless.paperdigest.ui

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.zip.CRC32
import java.util.zip.DeflaterOutputStream
import java.util.Base64
import java.util.Random
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test

class VerifiedMarkdownImagesTest {
 private fun validLargePng():String {
 val width=640;val height=640;val raw=ByteArrayOutputStream();val random=Random(17)
 repeat(height){raw.write(0);repeat(width){raw.write(random.nextInt(256));raw.write(random.nextInt(256));raw.write(random.nextInt(256))}}
 val compressed=ByteArrayOutputStream();DeflaterOutputStream(compressed).use{it.write(raw.toByteArray())}
 val output=ByteArrayOutputStream();val writer=DataOutputStream(output);writer.write(byteArrayOf(0x89.toByte(),0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))
 fun chunk(type:String,bytes:ByteArray){val name=type.toByteArray(Charsets.US_ASCII);writer.writeInt(bytes.size);writer.write(name);writer.write(bytes);val crc=CRC32();crc.update(name);crc.update(bytes);writer.writeInt(crc.value.toInt())}
 val ihdr=ByteArrayOutputStream();DataOutputStream(ihdr).use{it.writeInt(width);it.writeInt(height);it.writeByte(8);it.writeByte(2);it.writeByte(0);it.writeByte(0);it.writeByte(0)}
 chunk("IHDR",ihdr.toByteArray());chunk("IDAT",compressed.toByteArray());chunk("IEND",byteArrayOf());writer.flush()
 return "data:image/png;base64,"+Base64.getEncoder().encodeToString(output.toByteArray())
}
 @Test fun onlyVerifiedLargeImageMovesOutsideTextBudgetAndOriginalPixelsSurvive(){val uri=validLargePng();assertTrue(uri.length>1_000_000);val original="# Original\n\n![真实图注]($uri)\n\n\\(x+y\\)";val compact=compactVerifiedImageData(original,mapOf(uri to uri));assertTrue(compact.markdown.length<300);val prepared=ResearchRenderer.prepare(compact.markdown,compact.images);assertEquals(uri,Jsoup.parseBodyFragment(prepared.html).selectFirst("img")!!.attr("src"));assertEquals("真实图注",Jsoup.parseBodyFragment(prepared.html).selectFirst("img")!!.attr("alt"));assertEquals("x+y",prepared.formulae.single().tex);assertTrue(original.contains(uri))}
 @Test fun unknownLargeImageAndOrdinaryModelTextRemainBounded(){val uri=validLargePng();assertThrows(IllegalArgumentException::class.java){compactVerifiedImageData("![unknown]($uri)",emptyMap())};assertThrows(IllegalArgumentException::class.java){ResearchRenderer.prepare("![unverified]($uri)")};assertThrows(IllegalArgumentException::class.java){compactVerifiedImageData("x".repeat(1_000_001),emptyMap())}}
 @Test fun literalInlineFencedAndIndentedCodeDoesNotBecomeAnImageBudgetBypass(){val uri="data:image/png;base64,QUJD";for(code in listOf("`![code]($uri)`","````\n```\n![code]($uri)\n````","    ![code]($uri)","\t![code]($uri)")){assertEquals(code,compactVerifiedImageData(code,mapOf(uri to uri)).markdown)}}
 @Test fun verifiedReferenceImageAndAngleDestinationRetainCaption(){val uri="data:image/png;base64,QUJD";for(md in listOf("![图注][figure]\n\n[figure]: <$uri>","![图注](<$uri>)")){val c=compactVerifiedImageData(md,mapOf(uri to uri));val img=Jsoup.parseBodyFragment(ResearchRenderer.prepare(c.markdown,c.images).html).selectFirst("img")!!;assertEquals(uri,img.attr("src"));assertEquals("图注",img.attr("alt"))}}
}
