#![forbid(unsafe_code)]

//! Shared Loom wire types and pure domain transitions.
//!
//! This crate deliberately has no HTTP server, database, filesystem, clock or
//! secret-storage implementation. Serde enables JSON-compatible SQLite columns;
//! callers must still provide transactions and enforce byte limits.

pub mod canonical;
pub mod core;
pub mod domain;
pub mod error;
pub mod identity;
pub mod node;
pub mod pipeline;
pub mod policy;
mod source_work;
pub mod state;

pub use core::*;
pub use domain::*;
pub use error::{ProtocolError, ProtocolResult};
pub use identity::*;
pub use node::*;
pub use pipeline::*;
pub use policy::*;
pub use source_work::*;
pub use state::*;
