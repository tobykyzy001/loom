use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use loom_node::runner::{LocalNodeRunner, NodeOptions};
use loom_node::Bindings;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "loom-node",
    version,
    about = "Loom bare deterministic Local Node"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Debug, Subcommand)]
enum Command {
    Bind {
        #[arg(long)]
        state_dir: PathBuf,
        #[arg(long = "project-root", required = true)]
        project_roots: Vec<String>,
    },
    Start {
        /// Coordinator HTTP(S) base URL, not a prompt or implicit local service.
        #[arg(long)]
        coordinator: String,
        /// Private directory owned solely by this node identity (must be mode 700).
        #[arg(long)]
        state_dir: PathBuf,
        /// Private artifact/effect ledger directory distinct from every project root.
        #[arg(long)]
        artifact_dir: PathBuf,
        /// Repeatable PROJECT_ID=/CANONICAL/APPROVED/ROOT. Never defaults to cwd.
        #[arg(long = "project-root", required = true)]
        project_roots: Vec<String>,
        /// Optional enrollment override; prefer LOOM_ENROLLMENT_CODE environment input.
        #[arg(long, env = "LOOM_ENROLLMENT_CODE", hide_env_values = true)]
        enrollment_code: Option<String>,
        /// One bounded poll/execution cycle, then flush already due outbox messages.
        #[arg(long)]
        once: bool,
        /// Explicit heartbeat interval, still independent of 45-second real leases.
        #[arg(long, default_value_t=15, value_parser=bounded_heartbeat)]
        heartbeat_seconds: u64,
        /// Poll wait is intentionally in the controller-supported [1,15] window.
        #[arg(long, default_value_t=1, value_parser=bounded_poll)]
        wait_seconds: u64,
        /// Optional root -> project binding JSON, loaded read-only at startup.
        #[arg(long, env = "LOOM_BINDINGS_FILE")]
        bindings_file: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Bind {
            state_dir,
            project_roots,
        } => {
            let dir = prepare_private_root(&state_dir)?;
            let identity = loom_node::identity::Identity::open(&dir)?;
            let path = loom_node::binding::write_signed_binding(&dir, &identity, &project_roots)?;
            println!(
                "{}",
                serde_json::json!({"node_id":identity.node_id,"binding_file":path,"connected_identity":true})
            );
            Ok(())
        }
        Command::Start {
            coordinator,
            state_dir,
            artifact_dir,
            project_roots,
            enrollment_code,
            once,
            heartbeat_seconds,
            wait_seconds,
            bindings_file,
        } => {
            let initial = if bindings_file.is_some() {
                let identity = loom_node::identity::Identity::open_existing(
                    &prepare_private_root(&state_dir)?,
                )?;
                Bindings::load_as(
                    &project_roots,
                    bindings_file.as_deref(),
                    Some((
                        &identity.node_id,
                        &identity.installation_id,
                        identity.public_key(),
                    )),
                )?
            } else {
                Bindings::load(&project_roots, bindings_file.as_deref())?
            };
            let bindings = initial;
            let mut runner = LocalNodeRunner::open(NodeOptions {
                coordinator,
                state_dir,
                artifact_dir,
                bindings,
                wait_seconds,
                enrollment_code,
            })?;
            let started = runner.start().await?;
            // Only non-secret public identity and control-plane acknowledgement are printed.
            println!("{}", serde_json::to_string(&started)?);
            let mut cycles = 0u64;
            loop {
                match runner.once().await {
                    Ok(_status) => {}
                    Err(error) => {
                        eprintln!("loom-node cycle deferred: {error:#}");
                        if once {
                            bail!("single bounded cycle did not complete: {error:#}");
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                }
                cycles = cycles.saturating_add(1);
                if once {
                    break;
                }
                // Every network operation and sleep is bounded. The maintenance
                // endpoint refreshes a real poll lease; a local-only sleep cannot.
                if cycles.is_multiple_of(heartbeat_seconds.max(1)) {
                    if let Err(error) = runner.heartbeat().await {
                        eprintln!("loom-node heartbeat deferred: {error:#}");
                    }
                }
            }
            println!("{}", serde_json::to_string(&runner.public_state())?);
            Ok(())
        }
    }
}
fn prepare_private_root(path: &std::path::Path) -> Result<PathBuf> {
    loom_node::binding::prepare_owned_directory(path, "node state directory")
}

fn bounded_poll(value: &str) -> Result<u64, String> {
    let value = value.parse().map_err(|_| "wait must be an integer")?;
    if (1..=15).contains(&value) {
        Ok(value)
    } else {
        Err("poll wait must be from 1 through 15 seconds".to_owned())
    }
}
fn bounded_heartbeat(value: &str) -> Result<u64, String> {
    let value = value
        .parse()
        .map_err(|_| "heartbeat interval must be an integer")?;
    if (1..=60).contains(&value) {
        Ok(value)
    } else {
        Err("heartbeat interval must be from 1 through 60 seconds".to_owned())
    }
}
