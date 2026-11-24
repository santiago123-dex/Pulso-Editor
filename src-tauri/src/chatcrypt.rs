//! Cifrado en reposo del historial del chat de IA (`ai-chats.json`).
//!
//! El archivo se guarda cifrado con AES-256-GCM. La clave (32 bytes aleatorios) vive en el almacén de credenciales del sistema operativo,
//! como el token de GitHub y las claves de los proveedores, **nunca junto al archivo**. Así, copiar el archivo (una copia de seguridad,
//! una carpeta sincronizada, un disco que se presta) no basta para leer las conversaciones.
//!
//! Qué NO protege: a otro programa que corra con tu mismo usuario, que puede pedirle la clave al almacén igual que Pulso.
//!
//! Formato: `PCH1` (4 bytes) · nonce (12 bytes, nuevo en cada escritura) · texto cifrado con su etiqueta de autenticación (16 bytes).
//! Los 4 primeros bytes también se autentican, y un archivo sin esa marca se trata como el historial antiguo, en texto.
use crate::i18n::tr;
use base64::Engine;
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};

const MAGIC: &[u8; 4] = b"PCH1";
const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;
const SECRET_SERVICE: &str = "pulso-editor";
const SECRET_NAME: &str = "ai-history-key";

pub type Key = [u8; KEY_LEN];

/// ¿Es un archivo cifrado por este módulo (y no el historial antiguo en texto)?
pub fn is_encrypted(data: &[u8]) -> bool {
    data.starts_with(MAGIC)
}

pub fn new_key() -> Result<Key, String> {
    let mut k = [0u8; KEY_LEN];
    SystemRandom::new().fill(&mut k).map_err(|_| tr("No se pudo generar la clave de cifrado.").to_string())?;
    Ok(k)
}

fn sealing_key(key: &Key) -> Result<LessSafeKey, String> {
    UnboundKey::new(&AES_256_GCM, key).map(LessSafeKey::new).map_err(|_| tr("La clave de cifrado no es válida.").to_string())
}

pub fn encrypt(key: &Key, plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| tr("No se pudo generar la clave de cifrado.").to_string())?;
    let mut buf = plain.to_vec();
    sealing_key(key)?
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(MAGIC.as_slice()), &mut buf)
        .map_err(|_| tr("No se pudo cifrar el historial.").to_string())?;
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + buf.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(out)
}

/// Descifra. Falla si la clave no es la que cifró el archivo o si el archivo se alteró.
pub fn decrypt(key: &Key, data: &[u8]) -> Result<Vec<u8>, String> {
    let body = data.strip_prefix(MAGIC.as_slice()).filter(|b| b.len() >= NONCE_LEN + aead::AES_256_GCM.tag_len()).ok_or_else(|| tr("El historial cifrado está incompleto.").to_string())?;
    let (nonce, sealed) = body.split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| tr("El historial cifrado está incompleto.").to_string())?;
    let mut buf = sealed.to_vec();
    let plain = sealing_key(key)?
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(MAGIC.as_slice()), &mut buf)
        .map_err(|_| tr("No se pudo descifrar el historial: la clave no coincide o el archivo se alteró.").to_string())?;
    Ok(plain.to_vec())
}

// ---------- Dónde vive la clave ----------

/// Almacén de la clave: el del sistema operativo en la aplicación, y uno en memoria en las pruebas.
pub trait KeyStore {
    /// `Ok(None)`: todavía no hay clave. `Err`: el almacén no está disponible.
    fn get(&self) -> Result<Option<Key>, String>;
    fn set(&self, key: &Key) -> Result<(), String>;
}

/// El almacén de credenciales del sistema (Administrador de credenciales de Windows, Keychain o Secret Service), con el nombre de la entrada.
pub struct SystemKeyStore(pub &'static str);

/// La clave del historial del chat.
pub const HISTORY_KEY: SystemKeyStore = SystemKeyStore(SECRET_NAME);

impl SystemKeyStore {
    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SECRET_SERVICE, self.0).map_err(|e| e.to_string())
    }
}

impl KeyStore for SystemKeyStore {
    fn get(&self) -> Result<Option<Key>, String> {
        match self.entry()?.get_password() {
            // Una clave guardada pero ilegible se trata como «no hay»: nunca puede descifrar nada.
            Ok(p) => Ok(base64::engine::general_purpose::STANDARD.decode(p.trim()).ok().and_then(|b| Key::try_from(b.as_slice()).ok())),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, key: &Key) -> Result<(), String> {
        self.entry()?.set_password(&base64::engine::general_purpose::STANDARD.encode(key)).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use std::sync::Mutex;

    /// Almacén en memoria; con `broken` simula un sistema sin almacén de credenciales (Linux sin Secret Service, por ejemplo).
    #[derive(Default)]
    pub struct MemStore {
        pub key: Mutex<Option<Key>>,
        pub broken: bool,
    }

    impl KeyStore for MemStore {
        fn get(&self) -> Result<Option<Key>, String> {
            if self.broken {
                return Err("sin almacén".into());
            }
            Ok(*self.key.lock().unwrap())
        }

        fn set(&self, key: &Key) -> Result<(), String> {
            if self.broken {
                return Err("sin almacén".into());
            }
            *self.key.lock().unwrap() = Some(*key);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cifra_y_descifra_sin_dejar_el_texto_a_la_vista() {
        let key = new_key().unwrap();
        let plain = br#"[{"id":"a","title":"contrasena-de-prueba"}]"#;
        let sealed = encrypt(&key, plain).unwrap();
        assert!(is_encrypted(&sealed) && !is_encrypted(plain));
        assert!(!String::from_utf8_lossy(&sealed).contains("contrasena-de-prueba"));
        assert_eq!(decrypt(&key, &sealed).unwrap(), plain);
        // Cada escritura usa otro nonce: el mismo texto no da el mismo archivo.
        assert_ne!(sealed, encrypt(&key, plain).unwrap());
        // Un texto vacío también vale.
        assert_eq!(decrypt(&key, &encrypt(&key, b"").unwrap()).unwrap(), b"");
    }

    /// Con el almacén de credenciales de verdad de este equipo, y una entrada de prueba que se borra al terminar (nunca la del historial).
    /// `cargo test --lib con_el_almacen_del_sistema -- --ignored`
    #[test]
    #[ignore]
    fn con_el_almacen_del_sistema() {
        let store = SystemKeyStore("ai-history-key-prueba");
        let _ = store.entry().map(|e| e.delete_credential());
        assert_eq!(store.get().unwrap(), None, "sin entrada no hay clave");
        let key = new_key().unwrap();
        store.set(&key).unwrap();
        assert_eq!(store.get().unwrap(), Some(key), "la clave vuelve igual que se guardó");
        let sealed = encrypt(&store.get().unwrap().unwrap(), b"[1]").unwrap();
        assert_eq!(decrypt(&key, &sealed).unwrap(), b"[1]");
        store.entry().unwrap().delete_credential().unwrap();
        assert_eq!(store.get().unwrap(), None);
    }

    #[test]
    fn con_otra_clave_o_alterado_o_cortado_no_se_descifra() {
        let (key, other) = (new_key().unwrap(), new_key().unwrap());
        assert_ne!(key, other);
        let sealed = encrypt(&key, b"[1,2,3]").unwrap();
        assert!(decrypt(&other, &sealed).is_err());
        for i in [4, 10, sealed.len() - 1] {
            let mut bad = sealed.clone();
            bad[i] ^= 1;
            assert!(decrypt(&key, &bad).is_err(), "byte {i} alterado");
        }
        assert!(decrypt(&key, &sealed[..sealed.len() - 1]).is_err());
        assert!(decrypt(&key, &sealed[..10]).is_err());
        assert!(decrypt(&key, b"PCH1").is_err());
        assert!(decrypt(&key, b"[1,2,3]").is_err());
    }
}
