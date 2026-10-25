package com.nanless.paperdigest.ui

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.Base64
import java.util.Random
import java.util.zip.CRC32
import java.util.zip.DeflaterOutputStream

/** Real RGB PNG, fixed noise seed; uses only classes available to the Android/JVM test bootclasspath. */
internal fun validLargePng(width:Int=640,height:Int=640):String {
 val raw=ByteArrayOutputStream();val random=Random(17)
 repeat(height){raw.write(0);repeat(width){raw.write(random.nextInt(256));raw.write(random.nextInt(256));raw.write(random.nextInt(256))}}
 val compressed=ByteArrayOutputStream();DeflaterOutputStream(compressed).use{it.write(raw.toByteArray())}
 val output=ByteArrayOutputStream();val writer=DataOutputStream(output);writer.write(byteArrayOf(0x89.toByte(),0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))
 fun chunk(type:String,bytes:ByteArray){val name=type.toByteArray(Charsets.US_ASCII);writer.writeInt(bytes.size);writer.write(name);writer.write(bytes);val crc=CRC32();crc.update(name);crc.update(bytes);writer.writeInt(crc.value.toInt())}
 val ihdr=ByteArrayOutputStream();DataOutputStream(ihdr).use{it.writeInt(width);it.writeInt(height);it.writeByte(8);it.writeByte(2);it.writeByte(0);it.writeByte(0);it.writeByte(0)}
 chunk("IHDR",ihdr.toByteArray());chunk("IDAT",compressed.toByteArray());chunk("IEND",byteArrayOf());writer.flush()
 return "data:image/png;base64,"+Base64.getEncoder().encodeToString(output.toByteArray())
}
