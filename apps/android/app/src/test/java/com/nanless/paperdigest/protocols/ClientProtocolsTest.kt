package com.nanless.paperdigest.protocols

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ClientProtocolsTest {
    @Test fun sameStableNameSelectsCompleteHistoricalSchemaWithoutChangingItsHeader() {
        val fixture=JSONObject(requireNotNull(javaClass.classLoader!!.getResourceAsStream("client-protocol-history.json")).bufferedReader().use{it.readText()})
        val source=fixture.getJSONObject("catalog").getJSONArray("protocols").getJSONObject(0)
        val expected=fixture.getJSONObject("expected");val name=expected.getString("name")
        val current=JSONObject().put("contract",name).put("schemaFingerprint",expected.getString("currentFingerprint"))
        val formats=org.json.JSONArray().put(JSONObject().put("tag",name).put("fp",expected.getString("currentFingerprint")).put("variant",source.getString("currentVariant")).put("header",current).put("schema",source.getJSONObject("currentSchema")).put("historical",false))
        val history=source.getJSONArray("historical")
        for(i in 0 until history.length()){
            val item=history.getJSONObject(i);val header=item.getJSONObject("header")
            formats.put(JSONObject().put("tag",item.get("tag")).put("fp",header.opt("schemaFingerprint")?:JSONObject.NULL).put("variant",item.getString("variant")).put("header",header).put("schema",item.opt("schema")?:JSONObject.NULL).put("historical",true))
        }
        // Only the format lookup table in this test process is extended. The
        // complete source declarations and hashes are independently verified
        // by test_client_protocol_generation.py; no application data is loaded.
        val field=ClientProtocols::class.java.getDeclaredField("entries").apply{isAccessible=true}
        val entries=field.get(null) as JSONObject;assertFalse(entries.has(name))
        entries.put(name,JSONObject().put("schemaFingerprint",expected.getString("currentFingerprint")).put("formats",formats).put("headers",JSONObject().put(name,current)))
        try{
            val old=expected.getString("historicalFingerprint")
            val before=ClientProtocols.recordHeader(name,name,old)
            assertEquals(old,before.getString("schemaFingerprint"));assertTrue(ClientProtocols.hasValidHeader(before,name))
            assertFalse(ClientProtocols.isCurrentHeader(before,name));assertTrue(ClientProtocols.isCurrentHeader(current,name))
            assertEquals("original-payload",ClientProtocols.format(name,name,old))
            assertEquals("source-bound-payload",ClientProtocols.format(name,name,expected.getString("currentFingerprint")))
            assertThrows(IllegalArgumentException::class.java){ClientProtocols.format(name,name)}
            assertThrows(IllegalArgumentException::class.java){ClientProtocols.historicalContract(name,"original-payload")}
            assertFalse(ClientProtocols.hasValidHeader(JSONObject(before.toString()).put("schemaFingerprint","0".repeat(64)),name))
            val schema=ClientProtocols.declaredSchema(name,name,old);schema.put("algorithm","changed")
            assertEquals("original-bytes",ClientProtocols.declaredSchema(name,name,old).getString("algorithm"))
            assertTrue(ClientProtocols.hasValidHeader(JSONObject().put("version",1),name,"version"))
            assertFalse(ClientProtocols.hasValidHeader(JSONObject().put("version",true),name,"version"))
            assertTrue(ClientProtocols.hasValidHeader(JSONObject().put("contract","client-protocol-test-kind").put("kind","original-mode"),name))
            assertFalse(ClientProtocols.hasValidHeader(JSONObject().put("contract","client-protocol-test-kind").put("kind","other"),name))
            assertFalse(ClientProtocols.hasValidHeader(JSONObject().put("contract","client-protocol-test-kind"),name))
        }finally{entries.remove(name)}
    }
    @Test fun exactCurrentAndHistoricalHeaders() {
        val name="paperdigest-backup"
        val legacy="paperdigest-backup-v2"
        val current=ClientProtocols.record(name,JSONObject().put("files",org.json.JSONArray()))
        assertEquals(name,current.getString("contract"))
        assertTrue(ClientProtocols.hasValidHeader(current,name))
        assertFalse(ClientProtocols.hasValidHeader(JSONObject(current.toString()).put("schemaFingerprint","0".repeat(64)),name))
        assertFalse(ClientProtocols.hasValidHeader(JSONObject().put("contract",name),name))
        val original=JSONObject().put("contract",legacy)
        assertTrue(ClientProtocols.hasValidHeader(original,name))
        assertEquals(legacy,ClientProtocols.identityDomain(legacy,name))
        assertFalse(ClientProtocols.hasValidHeader(JSONObject(original.toString()).put("schemaFingerprint",ClientProtocols.schemaFingerprint(name)),name))
        assertFalse(ClientProtocols.isContract("paperdigest-backup-v999",name))
        assertFalse(ClientProtocols.isContract("paperdigest-storage-aliases-v1",name))
        assertEquals(setOf("contract","files"),ClientProtocols.recordKeys(legacy,name,setOf("files")))
        assertEquals(setOf("contract","schemaFingerprint","files"),ClientProtocols.recordKeys(name,name,setOf("files")))
        assertThrows(IllegalArgumentException::class.java) { ClientProtocols.record(name,JSONObject().put("contract",legacy)) }
    }
}
