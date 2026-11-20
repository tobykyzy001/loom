//! Read-only verification of the existing local Bare package candidate.
//! Hash/manifest validation is not a signature, installation, registration or grant.
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::fs::{self, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_METADATA: u64 = 16 * 1024;
const MAX_BINARY: u64 = 256 * 1024 * 1024;

#[derive(Debug)]
pub struct VerifiedManifest {
    pub source_manifest_sha256: String,
}

fn reject<T>() -> Result<T> {
    bail!(
        "Local package manifest or referenced binary failed the current Bare package verification"
    )
}

fn open_regular(path: &Path, maximum: u64) -> Result<(std::fs::File, Metadata)> {
    let original = fs::symlink_metadata(path).map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    if original.file_type().is_symlink()
        || !original.is_file()
        || original.len() == 0
        || original.len() > maximum
    {
        return reject();
    }
    #[cfg(unix)]
    if std::os::unix::fs::MetadataExt::nlink(&original) != 1 {
        return reject();
    }
    #[cfg(not(unix))]
    return reject();
    let file = fs::File::open(path).map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    let metadata = file.metadata().map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    if !metadata.is_file() || metadata.len() != original.len() {
        return reject();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.ino() != original.ino()
            || metadata.dev() != original.dev()
            || metadata.nlink() != 1
        {
            return reject();
        }
    }
    Ok((file, metadata))
}

/// Open only the fixed child through the already chosen directory descriptor.
/// This does not delegate selection to a possibly-renamed parent pathname.
#[cfg(unix)]
fn open_within_directory(
    directory: &std::fs::File,
    maximum: u64,
) -> Result<(std::fs::File, Metadata)> {
    let descriptor = rustix::fs::openat(
        directory,
        "loom-node",
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::empty(),
    ).map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    let file: std::fs::File = descriptor.into();
    let metadata = file.metadata().map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > maximum
        || std::os::unix::fs::MetadataExt::nlink(&metadata) != 1
    {
        return reject();
    }
    Ok((file, metadata))
}

fn read_bounded(file: &mut std::fs::File, maximum: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.by_ref()
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    if bytes.len() as u64 > maximum {
        return reject();
    }
    Ok(bytes)
}

fn unchanged_open_file(
    file: &std::fs::File,
    path: &Path,
    initial: &Metadata,
    actual_size: usize,
) -> Result<()> {
    let current = file.metadata().map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let on_disk = fs::symlink_metadata(path).map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
        if on_disk.file_type().is_symlink()
            || current.ino() != initial.ino()
            || current.dev() != initial.dev()
            || current.nlink() != 1
            || on_disk.ino() != current.ino()
            || on_disk.dev() != current.dev()
            || current.permissions().mode() != initial.permissions().mode()
            || current.len() != actual_size as u64
        {
            return reject();
        }
    }
    #[cfg(not(unix))]
    return reject();
    Ok(())
}

fn open_directory(path: &Path) -> Result<(std::fs::File, Metadata)> {
    let path_metadata = fs::symlink_metadata(path).map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_dir() {
        return reject();
    }
    let handle = fs::File::open(path).map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    let metadata = handle.metadata().map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    if !metadata.is_dir() {
        return reject();
    }
    Ok((handle, metadata))
}

fn unchanged_directory(handle: &std::fs::File, path: &Path, initial: &Metadata) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = handle.metadata().map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
        let on_disk = fs::symlink_metadata(path).map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
        if on_disk.file_type().is_symlink()
            || current.ino() != initial.ino()
            || current.dev() != initial.dev()
            || on_disk.ino() != current.ino()
            || on_disk.dev() != current.dev()
        {
            return reject();
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (handle, path, initial);
        reject()
    }
}

fn unchanged_binary_descriptor(
    file: &std::fs::File,
    initial: &Metadata,
    actual_size: usize,
) -> Result<()> {
    let current = file.metadata().map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if current.ino() != initial.ino()
            || current.dev() != initial.dev()
            || current.nlink() != 1
            || current.permissions().mode() != initial.permissions().mode()
            || current.len() != actual_size as u64
        {
            return reject();
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (file, initial);
        reject()
    }
}

fn string<'a>(value: &'a Value, member: &str) -> Result<&'a str> {
    match value.get(member).and_then(Value::as_str) {
        Some(value) => Ok(value),
        None => reject(),
    }
}

/// Read only the existing package format; never execute the code found there.
/// File descriptors and read counts are the source of byte/hash evidence, not
/// whether a pathname happened to look right during an earlier metadata check.
pub fn validate_local_package(path: &str) -> Result<VerifiedManifest> {
    let candidate = PathBuf::from(path);
    if path.is_empty() || path.len() > 4096 || !candidate.is_absolute() {
        return reject();
    }
    let (mut source_handle, _) = open_regular(&candidate, MAX_METADATA)?;
    let source = read_bounded(&mut source_handle, MAX_METADATA)?;
    unchanged_open_file(
        &source_handle,
        &candidate,
        &source_handle.metadata().map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?,
        source.len(),
    )?;
    let manifest: Value = loom_protocol::node::from_json_strict(&source).map_err(|error| anyhow::anyhow!(error).context("Local package manifest or referenced binary failed the current Bare package verification"))?;
    let object = manifest
        .as_object()
        .context("Manifest root must be an object")?;
    let manifest_value = Value::Object(object.clone());
    if string(&manifest_value, "schema")? != "loom.bare-host-package.v1"
        || string(&manifest_value, "variant")? != "native-single-file-current-host"
        || string(&manifest_value, "package_version")? != "0.1.0"
        || string(&manifest_value, "platform")? != "darwin"
        || string(&manifest_value, "arch")? != "arm64"
        || string(&manifest_value, "status")? != "built_not_installed_not_activated"
    {
        return reject();
    }
    let binary = manifest["binary"]
        .as_object()
        .context("Manifest binary metadata must be an object")?;
    if binary.get("relative_path").and_then(Value::as_str) != Some("./loom-node")
        || binary.get("filename").and_then(Value::as_str) != Some("loom-node")
    {
        return reject();
    }
    let directory = candidate
        .parent()
        .context("Package must have a parent directory")?;
    let (directory_handle, directory_metadata) = open_directory(directory)?;
    let (mut binary_handle, initial) = open_within_directory(&directory_handle, MAX_BINARY)?;
    if initial.len() < 28 {
        return reject();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if initial.permissions().mode() & 0o6000 != 0
            || binary["mode"].as_u64() != Some((initial.permissions().mode() & 0o777) as u64)
            || initial.permissions().mode() & 0o111 == 0
        {
            return reject();
        }
    }
    if binary["byte_count"].as_u64() != Some(initial.len()) {
        return reject();
    }
    let expected = binary["sha256"]
        .as_str()
        .context("Binary digest must be text")?;
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return reject();
    }
    let bytes = read_bounded(&mut binary_handle, MAX_BINARY)?;
    if bytes.len() != initial.len() as usize || bytes.len() < 16 {
        return reject();
    }
    unchanged_binary_descriptor(&binary_handle, &initial, bytes.len())?;
    // Thin little-endian Mach-O: arm64, executable image. A metadata-only arch
    // label or a FAT/multi-architecture alternative is not evidence of this form.
    if bytes[0..4] != [0xcf, 0xfa, 0xed, 0xfe]
        || bytes[4..8] != [0x0c, 0x00, 0x00, 0x01]
        || bytes[8..12] != [0x00, 0x00, 0x00, 0x00]
        || bytes[12..16] != [0x02, 0x00, 0x00, 0x00]
        || crate::sha256(&bytes) != expected
    {
        return reject();
    }
    unchanged_directory(&directory_handle, directory, &directory_metadata)?;
    Ok(VerifiedManifest {
        source_manifest_sha256: crate::sha256(source),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture() -> (tempfile::TempDir, PathBuf, Vec<u8>) {
        let root = tempfile::tempdir().unwrap();
        let manifest = root.path().join("manifest.json");
        let binary = root.path().join("loom-node");
        let mut bytes = vec![0u8; 64];
        bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        bytes[4..8].copy_from_slice(&[0x0c, 0, 0, 1]);
        bytes[8..12].copy_from_slice(&[0, 0, 0, 0]);
        bytes[12..16].copy_from_slice(&[2, 0, 0, 0]);
        std::fs::write(&binary, &bytes).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let value = serde_json::json!({
            "schema":"loom.bare-host-package.v1", "variant":"native-single-file-current-host",
            "package_version":"0.1.0", "platform":"darwin", "arch":"arm64",
            "status":"built_not_installed_not_activated",
            "binary": {
                "filename":"loom-node", "relative_path":"./loom-node",
                "byte_count":bytes.len(), "sha256":crate::sha256(&bytes), "mode":0o755,
            }
        });
        std::fs::write(&manifest, value.to_string()).unwrap();
        (root, manifest, bytes)
    }

    #[test]
    fn verifies_shape_and_hash_without_executing_or_leaking_paths() {
        let (_root, path, _) = fixture();
        assert!(validate_local_package(path.to_str().unwrap()).is_ok());
    }

    #[test]
    fn byte_mutation_and_self_reported_architecture_are_rejected() {
        let (root, path, mut bytes) = fixture();
        bytes[20] ^= 1;
        std::fs::write(root.path().join("loom-node"), &bytes).unwrap();
        assert!(validate_local_package(path.to_str().unwrap()).is_err());
        bytes[4] = 0x07;
        std::fs::write(root.path().join("loom-node"), &bytes).unwrap();
        assert!(validate_local_package(path.to_str().unwrap()).is_err());
    }

    #[test]
    fn aliases_and_missing_evidence_do_not_bypass_finite_filesystem_bounds() {
        let (root, manifest, _) = fixture();
        std::os::unix::fs::symlink(&manifest, root.path().join("alias.json")).unwrap();
        assert!(validate_local_package(root.path().join("alias.json").to_str().unwrap()).is_err());
        assert!(validate_local_package("/").is_err());
        assert!(validate_local_package("relative/manifest.json").is_err());
    }

    #[test]
    fn directory_relative_open_keeps_the_original_selected_binary_despite_path_swap() {
        let (a, a_manifest, a_bytes) = fixture();
        let (b, _b_manifest, mut b_bytes) = fixture();
        b_bytes[20] ^= 0x5a;
        std::fs::write(b.path().join("loom-node"), &b_bytes).unwrap();
        let arena = tempfile::tempdir().unwrap();
        let a_dir = arena.path().join("selected");
        let b_dir = arena.path().join("contender");
        std::fs::create_dir(&a_dir).unwrap();
        std::fs::create_dir(&b_dir).unwrap();
        std::fs::rename(a.path(), &a_dir).unwrap();
        std::fs::rename(b.path(), &b_dir).unwrap();
        let (directory, directory_meta) = open_directory(&a_dir).unwrap();
        let backup_a = arena.path().join("backup-a");
        std::fs::rename(&a_dir, &backup_a).unwrap();
        std::fs::rename(&b_dir, &a_dir).unwrap();
        let (mut child, child_meta) = open_within_directory(&directory, MAX_BINARY).unwrap();
        let bytes = read_bounded(&mut child, MAX_BINARY).unwrap();
        assert_eq!(crate::sha256(&bytes), crate::sha256(&a_bytes));
        unchanged_binary_descriptor(&child, &child_meta, bytes.len()).unwrap();
        assert_ne!(
            crate::sha256(std::fs::read(a_dir.join("loom-node")).unwrap()),
            crate::sha256(&a_bytes),
            "Same name after a swap is a different binary source"
        );
        assert!(
            std::fs::read_to_string(&a_manifest).is_err(),
            "The old selected name must not keep exposing A's manifest after the sibling swap"
        );
        assert!(
            unchanged_directory(&directory, &a_dir, &directory_meta).is_err(),
            "Path identity after swapping is not silently reconstructed as the same directory"
        );
        assert_eq!(
            crate::sha256(std::fs::read(backup_a.join("loom-node")).unwrap()),
            crate::sha256(&a_bytes)
        );
    }

    #[test]
    fn short_read_and_directory_aliases_fail_without_path_or_io_details() {
        let (root, path, bytes) = fixture();
        std::fs::write(root.path().join("loom-node"), &bytes[..7]).unwrap();
        for candidate in [
            path.to_str().unwrap(),
            "relative/manifest.json",
            "/missing/manifest.json",
        ] {
            let error = validate_local_package(candidate).unwrap_err().to_string();
            assert!(
                !error.contains(root.path().to_string_lossy().as_ref()),
                "{error}"
            );
            assert!(!error.contains(candidate), "{error}");
            assert_eq!(error, "Local package manifest or referenced binary failed the current Bare package verification");
        }
        let alias = root.path().join("directory-link");
        std::os::unix::fs::symlink(root.path(), &alias).unwrap();
        assert!(validate_local_package(alias.join("manifest.json").to_str().unwrap()).is_err());
    }
}
