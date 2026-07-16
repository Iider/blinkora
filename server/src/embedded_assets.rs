pub struct EmbeddedAsset {
    pub path: &'static str,
    pub bytes: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"));

pub fn static_asset(path: &str) -> Option<&'static [u8]> {
    EMBEDDED_ASSETS
        .binary_search_by_key(&path, |asset| asset.path)
        .ok()
        .map(|index| EMBEDDED_ASSETS[index].bytes)
}
