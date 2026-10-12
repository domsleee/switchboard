pub mod cli;
pub mod client_server_contract;
pub mod consts;
pub mod data;
pub mod envs;
pub mod errors;
pub mod home;
#[cfg(not(windows))]
mod home_unix;
#[cfg(windows)]
mod home_windows;
pub mod input;
pub mod kdl;
pub mod nested_session_contract;
pub mod pane_size;
pub mod position;
pub mod session_serialization;
pub mod setup;
pub mod shared;

pub mod channels; // Requires tokio
pub mod common_path;
pub mod downloader;
pub mod ipc; // Requires interprocess
pub mod logging; // Requires log4rs
pub mod nested_session;
#[cfg(feature = "web_server_capability")]
pub mod remote_session_tokens;
pub mod sessions;
#[cfg(feature = "web_server_capability")]
pub mod web_authentication_tokens;
#[cfg(feature = "web_server_capability")]
pub mod web_server_commands;
#[cfg(feature = "web_server_capability")]
pub mod web_server_contract;
#[cfg(any(windows, test))]
pub mod windows_ipc;

// TODO(hartan): Remove this re-export for the next minor release.
pub use ::prost;

// Vendored libraries
pub mod vendored;
