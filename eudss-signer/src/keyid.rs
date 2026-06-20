//! keyId = uppercase hex of the PKCS#11 CKA_ID.

pub fn key_id_from_cka_id(cka_id: &[u8]) -> String {
    hex::encode_upper(cka_id)
}

pub fn cka_id_from_key_id(key_id: &str) -> Option<Vec<u8>> {
    hex::decode(key_id).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_uppercase_of_cka_id() {
        assert_eq!(key_id_from_cka_id(&[0x01]), "01");
        assert_eq!(key_id_from_cka_id(&[0xab, 0xcd, 0xef]), "ABCDEF");
    }

    #[test]
    fn round_trips_back_to_bytes() {
        let id = key_id_from_cka_id(&[0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(cka_id_from_key_id(&id).unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn rejects_non_hex() {
        assert!(cka_id_from_key_id("zz").is_none());
    }
}
