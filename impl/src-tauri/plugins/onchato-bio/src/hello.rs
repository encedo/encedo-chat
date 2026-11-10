//! The unlock key of a software profile on Windows: a Windows Hello key.
//!
//! enroll: `KeyCredentialManager` makes an RSA key in the TPM (or Hello's
//! software store where there is no TPM), usable only after Windows Hello
//! verifies the person - a fingerprint, a face or the Hello PIN (the user's
//! call P4, 2026-11-09). The key signs a fixed challenge; RSASSA-PKCS1-v1_5 is
//! deterministic, so SHA-256 of the signature is the same 32 bytes every time.
//! Those bytes go back to the page, which seals the profile under them; the
//! slot keeps only the alias (KeePassXC derives its Hello key the same way).
//!
//! unlock: the same signature again, after the same prompt.
//!
//! Unlike Android, a new fingerprint does not invalidate the key; a reset of
//! Hello or its PIN deletes it, and the page then hears "missing".
//!
//! Every rejection is a code the page reads (web/src/passkey.ts): cancelled,
//! missing, lockout, unavailable, or "error: ...".

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use windows::core::{w, Array, HSTRING, PCWSTR};
use windows::Security::Credentials::{
    KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
};
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};

const PREFIX: &str = "onchato-unlock-";
/** What the key signs; the alias binds the signature to this one slot. */
const CHALLENGE: &str = "onchato-soft-unlock-hello-v1:";

#[derive(Serialize)]
pub struct Status {
    available: bool,
    platform: &'static str,
}

#[derive(Serialize)]
pub struct Secret {
    secret: String,
}

/** Random hex from the page; anything else could name a profile or collide with another app's entry. */
fn name_of(alias: &str) -> Result<HSTRING, String> {
    let hex = alias.len() == 32 && alias.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if hex {
        Ok(HSTRING::from(format!("{PREFIX}{alias}")))
    } else {
        Err("error: bad alias".into())
    }
}

fn err(e: windows::core::Error) -> String {
    format!("error: {} (0x{:08x})", e.message(), e.code().0)
}

fn code(s: KeyCredentialStatus) -> String {
    match s {
        KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => "cancelled".into(),
        KeyCredentialStatus::NotFound => "missing".into(),
        KeyCredentialStatus::SecurityDeviceLocked => "lockout".into(),
        other => format!("error: Hello status {}", other.0),
    }
}

/**
 * The Hello prompt is its own window and often opens BEHIND the app (a known
 * quirk for desktop apps). Find it for a few seconds and lift it.
 */
fn lift_prompt() {
    std::thread::spawn(|| {
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(100));
            // SAFETY: plain Win32 calls with static wide strings; no pointers kept.
            unsafe {
                if let Ok(h) = FindWindowW(w!("Credential Dialog Xaml Host"), PCWSTR::null()) {
                    if !h.is_invalid() {
                        let _ = SetForegroundWindow(h);
                        return;
                    }
                }
            }
        }
    });
}

/** The slot's secret: SHA-256 of the key's signature over the challenge. Prompts. */
fn derive(cred: &KeyCredential, alias: &str) -> Result<String, String> {
    let challenge = CryptographicBuffer::CreateFromByteArray(format!("{CHALLENGE}{alias}").as_bytes()).map_err(err)?;
    lift_prompt();
    let r = cred.RequestSignAsync(&challenge).map_err(err)?.get().map_err(err)?;
    let st = r.Status().map_err(err)?;
    if st != KeyCredentialStatus::Success {
        return Err(code(st));
    }
    let buf = r.Result().map_err(err)?;
    let mut sig = Array::<u8>::new();
    CryptographicBuffer::CopyToByteArray(&buf, &mut sig).map_err(err)?;
    if sig.is_empty() {
        return Err("error: empty signature".into());
    }
    Ok(B64.encode(Sha256::digest(&sig[..])))
}

fn forget(name: &HSTRING) {
    if let Ok(op) = KeyCredentialManager::DeleteAsync(name) {
        let _ = op.get();
    }
}

/** Hello blocks its caller until the person answers: never on the async runtime's threads. */
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("error: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn status() -> Result<Status, String> {
    blocking(|| {
        let available = KeyCredentialManager::IsSupportedAsync()
            .and_then(|op| op.get())
            .unwrap_or(false);
        Ok(Status { available, platform: "windows" })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn enroll(alias: String) -> Result<Secret, String> {
    blocking(move || {
        let name = name_of(&alias)?;
        lift_prompt();
        let r = KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::ReplaceExisting)
            .map_err(err)?
            .get()
            .map_err(err)?;
        let st = r.Status().map_err(err)?;
        if st != KeyCredentialStatus::Success {
            return Err(code(st));
        }
        let cred = r.Credential().map_err(err)?;
        match derive(&cred, &alias) {
            Ok(secret) => Ok(Secret { secret }),
            Err(e) => {
                forget(&name);
                Err(e)
            }
        }
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn unlock(alias: String) -> Result<Secret, String> {
    blocking(move || {
        let name = name_of(&alias)?;
        let r = KeyCredentialManager::OpenAsync(&name).map_err(err)?.get().map_err(err)?;
        let st = r.Status().map_err(err)?;
        if st != KeyCredentialStatus::Success {
            return Err(code(st));
        }
        let cred = r.Credential().map_err(err)?;
        Ok(Secret { secret: derive(&cred, &alias)? })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn remove(alias: String) -> Result<(), String> {
    blocking(move || {
        let name = name_of(&alias)?;
        forget(&name);
        Ok(())
    })
    .await
}
