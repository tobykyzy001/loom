//! Authenticated versioned Loom control plane with a durable single-writer store.
#![forbid(unsafe_code)]
pub mod api;
mod command; // CLI
mod maintenance;
mod node_api;
mod store;

use anyhow::{bail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use clap::{Parser, Subcommand};
// Node key verification is provided by the shared protocol crate.
use serde_json::Value;
use sha2::Digest;
use std::{
    fs,
    path::Path,
    path::PathBuf,
    sync::Arc,
    // Clock semantics are explicit UTC in protocol records.
};

#[derive(Parser)]
#[command(
    name = "loom",
    about = "Loom personal Agent fabric coordinator and bare node"
)]
pub struct Cli {
    #[arg(long, default_value = ".loom")]
    pub data_dir: PathBuf,
    #[command(subcommand)]
    pub command: Command,
}
#[derive(Subcommand)]
pub enum Command {
    Serve {
        #[arg(long, default_value = "127.0.0.1:8787")]
        listen: String,
        #[arg(long)]
        web_dir: Option<PathBuf>,
    },
    Smoke {
        #[arg(long)]
        directory: Option<PathBuf>,
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: String,
    },
    Doctor,
    Reconcile,
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}
pub fn sha256(bytes: impl AsRef<[u8]>) -> String {
    store::hex(sha2::Sha256::digest(bytes.as_ref()))
}
pub fn token() -> String {
    URL_SAFE_NO_PAD.encode(random32())
}
pub fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut b);
    b
}
pub fn parse_time(text: &str) -> Result<chrono::DateTime<chrono::Utc>> {
    Ok(chrono::DateTime::parse_from_rfc3339(text)?.with_timezone(&chrono::Utc))
}
pub fn uuid(text: &str) -> Result<uuid::Uuid> {
    Ok(uuid::Uuid::parse_str(text)?)
}
pub fn required<'a>(body: &'a Value, field: &str, max: usize) -> api::ApiResult<&'a str> {
    body.get(field)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= max)
        .ok_or_else(|| {
            api::ApiError::bad(format!("{field} must be nonempty and at most {max} bytes"))
        })
}
pub fn safe_relative(value: &str) -> Result<PathBuf> {
    loom_protocol::RelativePath::parse(value)?;
    Ok(Path::new(value).to_path_buf())
}
pub fn public_key_identity(
    encoded: &str,
    node_id: &str,
    installation: &str,
) -> Result<loom_protocol::NodePublicKey> {
    let key = loom_protocol::NodePublicKey::from_base64url(encoded)?;
    if key.node_id()?.as_str() != node_id {
        bail!("node identity does not match submitted public key")
    }
    loom_protocol::InstallationId::parse(installation)?;
    Ok(key)
}
pub fn signature(key: &loom_protocol::NodePublicKey, nonce: &str, signature: &str) -> Result<()> {
    key.verify_challenge(&loom_protocol::ChallengeNonce::parse(nonce)?, signature)?;
    Ok(())
}

pub fn main() -> Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run_cli())
}

async fn run_cli() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "loom_concierge=info".into()),
        )
        .init();
    let cli = Cli::parse();
    match cli.command {
        Command::Serve { listen, web_dir } => {
            let token = std::env::var("LOOM_CLIENT_TOKEN").ok();
            let state = api::State::open(cli.data_dir, token.as_deref())?;
            if token.is_none() && state.bootstrap_token_written {
                eprintln!("First-run administrative client token: {}\nStored only in the dedicated data directory; configure an authenticated client before exposing this service.",state.bootstrap_token);
            }
            let settings = state
                .store
                .lock()
                .map_err(|_| anyhow::anyhow!("store lock"))?
                .setting("listen");
            if settings.is_none() {
                state
                    .store
                    .lock()
                    .map_err(|_| anyhow::anyhow!("store lock"))?
                    .set_setting("listen", &listen)?;
            }
            api::serve(Arc::new(state), listen, web_dir).await?;
        }
        Command::Smoke { directory, listen } => command::smoke(directory, listen).await?,
        Command::Doctor => command::doctor(&cli.data_dir).await?,
        Command::Reconcile => command::reconcile(&cli.data_dir).await?,
    }
    Ok(())
}
