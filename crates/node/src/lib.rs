//! Bare Rust Local Node: authenticated outbound coordinator protocol, explicit
//! host ProjectBindings, a single deterministic file executor, private durable
//! state, idempotent artifact/report delivery and honest recovery outcomes.
//!
//! This crate never imports Concierge, owns no global task authority and executes
//! no arbitrary shell commands or LLM requests.

#![forbid(unsafe_code)]

pub mod binding;
pub mod client;
pub mod executor;
pub mod identity;
pub mod model_descriptor;
pub mod runner;
pub mod state;
pub mod storage;
pub mod wire;

pub use binding::{Binding, Bindings};
pub use runner::{LocalNodeRunner, NodeOptions, TickStatus};

pub const NODE_BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");
