//! Fingerprints what an engine is built from, so an update that does not change
//! the engine does not move any session to a new one.
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

fn collect(path: &Path, files: &mut Vec<PathBuf>) {
    if path.is_file() {
        files.push(path.to_path_buf());
    } else if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            collect(&entry.path(), files);
        }
    }
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    for input in [
        "zellij-server/src",
        "zellij-utils/src",
        "Cargo.toml",
        "Cargo.lock",
    ] {
        let path = root.join(input);
        println!("cargo:rerun-if-changed={}", path.display());
        collect(&path, &mut files);
    }
    files.sort();
    let mut hasher = DefaultHasher::new();
    for file in files {
        if let Ok(bytes) = fs::read(&file) {
            file.strip_prefix(&root).unwrap_or(&file).hash(&mut hasher);
            bytes.hash(&mut hasher);
        }
    }
    println!(
        "cargo:rustc-env=SWITCHBOARD_ENGINE_FINGERPRINT={:016x}",
        hasher.finish()
    );
}
