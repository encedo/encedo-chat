package com.encedo.onchato.bio

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/*
 * The unlock key of a software profile (SPEC 4.5, Unlock slot).
 *
 * enroll: a new AES-256-GCM key in AndroidKeyStore (in the TEE), usable only
 * within AUTH_WINDOW seconds after the person proves it is them - a strong
 * biometric or the device's own PIN/pattern/password (the user's call P4,
 * 2026-11-09) - and invalidated when a fingerprint is added. Right after a
 * BiometricPrompt succeeds, 32 random bytes are sealed under that key. The
 * bytes go back to the page, which seals the profile under them; the sealing
 * goes into the slot.
 *
 * unlock: the same prompt, then the key opens the sealing; the 32 bytes come back.
 *
 * Why a window and not a per-use key bound by a CryptoObject: on a Galaxy S24
 * (2026-11-10) the per-use key failed doFinal with KEY_USER_NOT_AUTHENTICATED
 * ("No operation auth token received") after a successful prompt, in the TEE
 * as in StrongBox. Per-operation binding protects nothing here anyway: the
 * secret itself goes to the page.
 *
 * Every rejection's message is a code the page reads (web/src/passkey.ts):
 * cancelled, invalidated, missing, busy, unavailable, lockout, or "error: ...".
 *
 * Code is ASCII (the repo's rule).
 */

private const val KEYSTORE = "AndroidKeyStore"
private const val PREFIX = "onchato-unlock-"
private const val AUTHENTICATORS = BIOMETRIC_STRONG or DEVICE_CREDENTIAL
/** Seconds a proof keeps the key usable; the key is used at once after the prompt. */
private const val AUTH_WINDOW = 10

@InvokeArg
class EnrollArgs {
    lateinit var alias: String
    var title: String = "onchato"
    var subtitle: String = ""
}

@InvokeArg
class UnlockArgs {
    lateinit var alias: String
    lateinit var iv: String
    lateinit var ct: String
    var title: String = "onchato"
    var subtitle: String = ""
}

@InvokeArg
class RemoveArgs {
    lateinit var alias: String
}

@TauriPlugin
class BioPlugin(private val activity: Activity) : Plugin(activity) {
    @Volatile private var busy = false

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    /** Random hex from the page; anything else could name a profile or collide with another app's entry. */
    private fun aliasOf(raw: String): String? =
        if (Regex("^[0-9a-f]{32}$").matches(raw)) PREFIX + raw else null

    private fun available(): Boolean {
        val km = activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        return km.isDeviceSecure &&
            BiometricManager.from(activity).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS
    }

    @Command
    fun status(invoke: Invoke) {
        val out = JSObject()
        out.put("available", try { available() } catch (e: Exception) { false })
        invoke.resolve(out)
    }

    private fun spec(alias: String): KeyGenParameterSpec =
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(AUTH_WINDOW, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .setInvalidatedByBiometricEnrollment(true)
            .build()

    /** In the TEE: StrongBox is not asked for (one fewer vendor path to break; just as non-exportable). */
    private fun newKey(alias: String): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(spec(alias))
        return gen.generateKey()
    }

    /** The whole cause chain: a keystore failure says what it is two levels down. */
    private fun why(e: Throwable): String {
        val parts = mutableListOf<String>()
        var t: Throwable? = e
        while (t != null && parts.size < 4) {
            parts.add(t.javaClass.simpleName + (t.message?.let { ": $it" } ?: ""))
            t = t.cause
        }
        return parts.joinToString(" <- ")
    }

    private fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)

    @Command
    fun enroll(invoke: Invoke) {
        val args = invoke.parseArgs(EnrollArgs::class.java)
        val alias = aliasOf(args.alias) ?: return invoke.reject("error: bad alias")
        if (!available()) return invoke.reject("unavailable")
        val key: SecretKey
        try {
            val ks = keyStore()
            if (ks.containsAlias(alias)) ks.deleteEntry(alias)
            key = newKey(alias)
        } catch (e: Exception) {
            forget(alias)
            return invoke.reject("error: " + why(e))
        }
        prompt(invoke, args.title, args.subtitle, onFail = { forget(alias) }) {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, key)
            c.updateAAD(alias.toByteArray(Charsets.US_ASCII))
            val secret = ByteArray(32).also { SecureRandom().nextBytes(it) }
            try {
                val ct = c.doFinal(secret)
                val out = JSObject()
                out.put("secret", b64(secret))
                out.put("iv", b64(c.iv))
                out.put("ct", b64(ct))
                out
            } finally { secret.fill(0) }
        }
    }

    @Command
    fun unlock(invoke: Invoke) {
        val args = invoke.parseArgs(UnlockArgs::class.java)
        val alias = aliasOf(args.alias) ?: return invoke.reject("error: bad alias")
        val key = try {
            keyStore().getKey(alias, null) as SecretKey? ?: return invoke.reject("missing")
        } catch (e: Exception) {
            return invoke.reject("error: " + why(e))
        }
        try {
            // Before the prompt: a key a new fingerprint killed fails here
            // already, so nobody is asked for a finger that cannot help.
            Cipher.getInstance("AES/GCM/NoPadding").init(Cipher.ENCRYPT_MODE, key)
        } catch (e: KeyPermanentlyInvalidatedException) {
            // A fingerprint was added or the screen lock removed: the key is dead for good.
            forget(alias)
            return invoke.reject("invalidated")
        } catch (e: android.security.keystore.UserNotAuthenticatedException) {
            // Expected: the key is alive and waits for the prompt.
        } catch (e: Exception) {
            return invoke.reject("error: " + why(e))
        }
        val iv: ByteArray
        val ct: ByteArray
        try {
            iv = Base64.decode(args.iv, Base64.NO_WRAP)
            ct = Base64.decode(args.ct, Base64.NO_WRAP)
        } catch (e: Exception) { return invoke.reject("error: bad ct") }
        prompt(invoke, args.title, args.subtitle, onFail = {}) {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            c.updateAAD(alias.toByteArray(Charsets.US_ASCII))
            val secret = c.doFinal(ct)
            try {
                val out = JSObject()
                out.put("secret", b64(secret))
                out
            } finally { secret.fill(0) }
        }
    }

    @Command
    fun remove(invoke: Invoke) {
        val args = invoke.parseArgs(RemoveArgs::class.java)
        val alias = aliasOf(args.alias) ?: return invoke.reject("error: bad alias")
        forget(alias)
        invoke.resolve()
    }

    private fun forget(alias: String) {
        try { keyStore().deleteEntry(alias) } catch (_: Exception) {}
    }

    /**
     * One prompt at a time. `use` runs right after it succeeds, inside the
     * key's window, and builds the answer; its failure is the page's error.
     */
    private fun prompt(
        invoke: Invoke, title: String, subtitle: String,
        onFail: () -> Unit, use: () -> JSObject,
    ) {
        if (busy) return invoke.reject("busy")
        val host = activity as? FragmentActivity ?: return invoke.reject("error: no fragment activity")
        busy = true
        activity.runOnUiThread {
            val callback = object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    busy = false
                    try {
                        invoke.resolve(use())
                    } catch (e: KeyPermanentlyInvalidatedException) {
                        onFail(); invoke.reject("invalidated")
                    } catch (e: javax.crypto.AEADBadTagException) {
                        // The slot's sealing and this key do not belong together: the slot is dead.
                        onFail(); invoke.reject("invalidated")
                    } catch (e: Exception) {
                        onFail(); invoke.reject("error: " + why(e))
                    }
                }

                override fun onAuthenticationError(code: Int, msg: CharSequence) {
                    busy = false
                    onFail()
                    invoke.reject(
                        when (code) {
                            BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                            BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_TIMEOUT -> "cancelled"
                            BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "lockout"
                            BiometricPrompt.ERROR_NO_BIOMETRICS, BiometricPrompt.ERROR_HW_NOT_PRESENT,
                            BiometricPrompt.ERROR_HW_UNAVAILABLE, BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "unavailable"
                            else -> "error: $msg"
                        }
                    )
                }
                // onAuthenticationFailed: one finger not recognised; the prompt stays up.
            }
            try {
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .apply { if (subtitle.isNotEmpty()) setSubtitle(subtitle) }
                    .setAllowedAuthenticators(AUTHENTICATORS)
                    .build()
                BiometricPrompt(host, ContextCompat.getMainExecutor(activity), callback)
                    .authenticate(info)
            } catch (e: Exception) {
                busy = false
                onFail()
                invoke.reject("error: " + why(e))
            }
        }
    }
}
