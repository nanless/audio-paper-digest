package com.nanless.paperdigest.data

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class ModelKeyBindingTest {
    @Test fun changingDestinationNeverCarriesAnExistingCredentialToNewAddress() {
        val root = Files.createTempDirectory("model-key-binding-").toRealPath().toFile(); val binding = ModelKeyBinding(root)
        assertThrows(AppFailure::class.java) { binding.requireEndpoint("https://route-a.example/v1") }
        binding.bind("https://route-a.example/v1/"); binding.requireEndpoint("https://route-a.example/v1")
        assertThrows(AppFailure::class.java) { binding.requireEndpoint("https://route-b.example/v1") }
        binding.clear(); assertThrows(AppFailure::class.java) { binding.requireEndpoint("https://route-a.example/v1") }
        assertFalse(root.walkTopDown().filter { it.isFile }.any { it.readText().contains("Bearer") })
    }
}
