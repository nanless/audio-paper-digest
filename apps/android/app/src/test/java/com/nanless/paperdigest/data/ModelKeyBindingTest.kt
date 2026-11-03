package com.nanless.paperdigest.data

import org.junit.Assert.*
import org.json.JSONObject
import java.io.File
import com.nanless.paperdigest.protocols.ClientProtocols
import org.junit.Test
import java.nio.file.Files

class ModelKeyBindingTest {
    @Test fun originalBindingBytesRemainUntouchedAndCurrentFingerprintIsRequired(){
        val root=Files.createTempDirectory("model-key-protocol-").toRealPath().toFile()
        try {
            val file=File(root,"model-key-binding.json")
            val original=JSONObject().put("contract","paperdigest-model-key-binding-v1").put("endpoint","https://synthetic.invalid/v1").toString().toByteArray()
            file.writeBytes(original);ModelKeyBinding(root).requireEndpoint("https://synthetic.invalid/v1/")
            assertArrayEquals(original,file.readBytes())
            ModelKeyBinding(root).bind("https://synthetic.invalid/v1/")
            val current=JSONObject(file.readText());assertTrue(ClientProtocols.isCurrentHeader(current,"paperdigest-model-key-binding"))
            current.put("schemaFingerprint","0".repeat(64));file.writeText(current.toString())
            assertThrows(AppFailure::class.java){ModelKeyBinding(root).requireEndpoint("https://synthetic.invalid/v1")}
        }finally{root.deleteRecursively()}
    }
    @Test fun deviceEpochKeepsHistoricalBytesAndRejectsUnknownCurrentShape(){
        val root=Files.createTempDirectory("dispatch-protocol-").toRealPath().toFile()
        try {
            val file=File(root,"dispatch.json");val epoch=java.util.UUID.randomUUID().toString()
            val original=JSONObject().put("contract","paperdigest-device-dispatch-v1").put("epoch",epoch).toString().toByteArray()
            file.writeBytes(original);val dispatch=WorkspaceDispatch(root);assertEquals(epoch,dispatch.epoch);assertArrayEquals(original,file.readBytes())
            dispatch.rotate();val current=JSONObject(file.readText());assertTrue(ClientProtocols.isCurrentHeader(current,"paperdigest-device-dispatch"));assertNotEquals(epoch,dispatch.epoch)
            current.put("schemaFingerprint","0".repeat(64));file.writeText(current.toString())
            assertThrows(IllegalArgumentException::class.java){WorkspaceDispatch(root)}
        }finally{root.deleteRecursively()}
    }
    @Test fun changingDestinationNeverCarriesAnExistingCredentialToNewAddress() {
        val root = Files.createTempDirectory("model-key-binding-").toRealPath().toFile(); val binding = ModelKeyBinding(root)
        assertThrows(AppFailure::class.java) { binding.requireEndpoint("https://route-a.example/v1") }
        binding.bind("https://route-a.example/v1/"); binding.requireEndpoint("https://route-a.example/v1")
        assertThrows(AppFailure::class.java) { binding.requireEndpoint("https://route-b.example/v1") }
        binding.clear(); assertThrows(AppFailure::class.java) { binding.requireEndpoint("https://route-a.example/v1") }
        assertFalse(root.walkTopDown().filter { it.isFile }.any { it.readText().contains("Bearer") })
    }
}
