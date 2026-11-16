use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Reject filesystem objects that could redirect an existing controlled directory.
pub fn ensure_private_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("controlled directory must be an explicit absolute path");
    }
    if path == Path::new("/") || Some(path) == home_directory().as_deref() {
        bail!("refusing a broad root or home directory as node storage");
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!("controlled root is a symlink or non-directory");
        }
        ensure_private_permissions(path)?;
        return Ok(path.to_owned());
    }
    let base = path
        .parent()
        .context("controlled directory must have a parent")?;
    let name = path
        .file_name()
        .context("controlled directory needs a filename")?;
    // Existing ancestors are read-only facts, never chmod-ed. Private permission
    // enforcement applies only to this explicitly created owned directory. The
    // system `/var` alias on macOS is handled as an ambient path, not trusted input.
    if !base.exists() {
        if let Some(parent) = base.parent() {
            if !parent.exists() {
                bail!("the entire owned private directory chain must pre-exist except its final private child; refusing to chmod/create broad ancestors");
            }
        }
    }
    let base = fs::canonicalize(base)
        .with_context(|| format!("canonicalize controlled storage parent {}", base.display()))?;
    if base == Path::new("/") {
        bail!("controlled root must not be directly under filesystem root");
    }
    ensure_private_directory_from_canonical_parent(&base, name)
}

fn ensure_private_directory_from_canonical_parent(
    base: &Path,
    name: &std::ffi::OsStr,
) -> Result<PathBuf> {
    let path = base.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!(
                    "controlled directory contains a symlink or non-directory: {}",
                    path.display()
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Directory creation uses the process umask; immediately restrict the
            // newly created, empty private directory before writing any state.
            fs::create_dir(&path)?;
            make_private_permissions(&path)?;
        }
        Err(error) => return Err(error.into()),
    }
    ensure_private_permissions(&path)?;
    if path == Path::new("/") || Some(path.as_path()) == home_directory().as_deref() {
        bail!("refusing a broad root or home directory as node storage");
    }
    Ok(path)
}

#[cfg(unix)]
fn make_private_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn make_private_permissions(_path: &Path) -> Result<()> {
    bail!("private node directory ACL enforcement is not implemented on this platform")
}

#[cfg(unix)]
fn ensure_private_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    let mode = permissions.mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!("private node directory {} must not be accessible by group/other (mode {:o}, expected 700)", path.display(), mode);
    }
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn ensure_private_permissions(_path: &Path) -> Result<()> {
    // Windows ACL deployment is a separately verified platform feature, not a claim
    // derived from compiling this POSIX-oriented bare host on that target.
    bail!("private node directory ACL enforcement is not implemented on this platform")
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok())
}

pub fn private_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::symlink_metadata(path)?.permissions().mode() & 0o777;
        if mode != 0o600 {
            bail!(
                "private node file {} must have mode 600 (found {:o})",
                path.display(),
                mode
            );
        }
    }
    Ok(())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("atomic write target has no parent")?;
    ensure_private_directory(parent)?;
    let temporary = parent.join(format!(
        ".loom-{}-{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    ));
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?
    };
    #[cfg(not(unix))]
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    let result = (|| -> Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            bail!("refusing to replace a symlink");
        }
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        {
            let directory = fs::File::open(parent)?;
            directory.sync_all()?;
        }
        #[cfg(unix)]
        private_file(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn atomic_json(path: &Path, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}

pub fn read_json(path: &Path) -> Result<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => {
            private_file(path)?;
            Ok(Some(
                serde_json::from_slice(&bytes)
                    .with_context(|| format!("parse {}", path.display()))?,
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
