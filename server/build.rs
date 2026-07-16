use std::env;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn main() -> io::Result<()> {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR"));
    let schema_path = manifest_dir.join("../db/schema.sqlite.sql");
    let public_dir = manifest_dir.join("../dist/public");
    let output_path =
        PathBuf::from(env::var("OUT_DIR").expect("Cargo sets OUT_DIR")).join("embedded_assets.rs");

    println!("cargo:rerun-if-changed={}", schema_path.display());
    println!("cargo:rerun-if-changed={}", public_dir.display());

    let mut assets = Vec::new();
    if public_dir.is_dir() {
        collect_assets(&public_dir, &public_dir, &mut assets)?;
    } else if env::var("PROFILE").as_deref() == Ok("release") {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "dist/public is required for a release build; run `bun run build:web --force` first",
        ));
    } else {
        println!(
            "cargo:warning=dist/public is absent; the binary will not contain the web UI. Run `bun run build:web --force` before a release build."
        );
    }
    assets.sort_by(|left, right| left.0.cmp(&right.0));

    let mut output = File::create(output_path)?;
    writeln!(
        output,
        "pub const EMBEDDED_SCHEMA_SQL: &str = include_str!({});",
        rust_string(&schema_path)
    )?;
    writeln!(output, "pub static EMBEDDED_ASSETS: &[EmbeddedAsset] = &[")?;
    for (relative_path, absolute_path) in assets {
        writeln!(
            output,
            "    EmbeddedAsset {{ path: {}, bytes: include_bytes!({}) }},",
            format!("{relative_path:?}"),
            rust_string(&absolute_path)
        )?;
    }
    writeln!(output, "];")?;
    Ok(())
}

fn collect_assets(
    root: &Path,
    directory: &Path,
    assets: &mut Vec<(String, PathBuf)>,
) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            collect_assets(root, &path, assets)?;
        } else if metadata.is_file() {
            let relative_path = path
                .strip_prefix(root)
                .expect("asset is below the public root")
                .to_string_lossy()
                .replace('\\', "/");
            println!("cargo:rerun-if-changed={}", path.display());
            assets.push((relative_path, path));
        }
    }
    Ok(())
}

fn rust_string(path: &Path) -> String {
    format!("{:?}", path.to_string_lossy())
}
