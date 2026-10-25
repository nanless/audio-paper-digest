package com.nanless.paperdigest.secret

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.nanless.paperdigest.cloud.BackupCodec
import java.io.File
import java.nio.file.Files
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface SecretStore {
    fun save(scope: String, secret: String)
    fun load(scope: String): String?
    fun remove(scope: String)
}
class SecretUnavailable : Exception("无法读取本机保存的密码；请在安全设置中重新保存或处理设备解锁许可")

/** Arbitrary passwords are encrypted by a non-exportable, app-owned Keystore key. */
class SecretVault(context: Context) : SecretStore {
    private val directory = File(context.noBackupFilesDir, "PaperDigestSecrets").also {
        if (!it.exists()) require(it.mkdir()); BackupCodec.checkedDirectory(it); BackupCodec.privateDirectory(it)
    }
    private val store get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun validate(scope: String) {
        require(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,119}").matches(scope) && !scope.contains("..")) { "密码用途标识无效" }
    }
    private fun alias(scope: String) = "com.nanless.paperdigest.vault.$scope"
    private fun file(scope: String) = File(directory, "$scope.vault")
    private fun key(scope: String, create: Boolean): SecretKey? {
        val existing = store.getKey(alias(scope), null)
        if (existing != null) return existing as? SecretKey ?: throw SecretUnavailable()
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias(scope), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }
    @Synchronized override fun save(scope: String, secret: String) {
        validate(scope); require(secret.isNotEmpty() && secret.toByteArray(Charsets.UTF_8).size <= 64 * 1024) { "密码为空或过长" }
        val raw = secret.toByteArray(Charsets.UTF_8)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(scope, true)); cipher.updateAAD(scope.toByteArray(Charsets.UTF_8))
            val iv = cipher.iv; require(iv.size == 12)
            BackupCodec.atomicBytes(file(scope), byteArrayOf(0x50, 0x44, 0x56, 1) + iv + cipher.doFinal(raw))
        } catch (e: Exception) { throw SecretUnavailable() } finally { raw.fill(0) }
    }
    @Synchronized override fun load(scope: String): String? {
        validate(scope); val file = file(scope)
        if (!file.exists()) { if (Files.isSymbolicLink(file.toPath())) throw SecretUnavailable(); return null }
        try {
            require(!Files.isSymbolicLink(file.toPath()) && file.isFile && file.length() in 32..(64 * 1024 + 32))
            val bytes = file.readBytes(); require(bytes.take(4).toByteArray().contentEquals(byteArrayOf(0x50, 0x44, 0x56, 1)))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(scope, false) ?: throw SecretUnavailable(), GCMParameterSpec(128, bytes.copyOfRange(4, 16)))
            cipher.updateAAD(scope.toByteArray(Charsets.UTF_8)); val plain = cipher.doFinal(bytes, 16, bytes.size - 16)
            return try { plain.toString(Charsets.UTF_8) } finally { plain.fill(0) }
        } catch (e: Exception) { throw SecretUnavailable() }
    }
    @Synchronized override fun remove(scope: String) {
        validate(scope)
        try {
            val file = file(scope); require(!Files.isSymbolicLink(file.toPath()))
            if (file.exists()) require(file.delete())
            store.deleteEntry(alias(scope))
        } catch (e: Exception) { throw SecretUnavailable() }
    }
}
