//! Subcommands for building.
//!
//! Currently has the following functions:
//!
//! - [`build`]: Builds general cargo projects (i.e. zellij components) with `cargo build`
use crate::{flags, metadata, WorkspaceMember};
use anyhow::Context;
use std::path::Path;
use xshell::{cmd, Shell};

/// Build members of the zellij workspace.
///
/// Build behavior is controlled by the [`flags`](flags::Build). Calls some variation of `cargo
/// build` under the hood.
pub fn build(sh: &Shell, flags: flags::Build) -> anyhow::Result<()> {
    let _pd = sh.push_dir(crate::project_root());

    let cargo = crate::cargo()?;
    // Retained CLI flag for older build scripts; every Switchboard build is plugin-free.
    let _ = flags.no_plugins;
    if flags.plugins_only {
        anyhow::bail!("Switchboard does not support WebAssembly plugins");
    }
    run_proto_codegen(sh, false);

    // Build non-plugin crates (native target).
    if !flags.plugins_only {
        for WorkspaceMember { crate_name, .. } in crate::workspace_members()
            .iter()
            .filter(|member| member.build && !member.crate_name.contains("plugins"))
        {
            let err_context = || format!("failed to build '{crate_name}'");

            let _pd = sh.push_dir(Path::new(crate_name));
            println!();
            let msg = format!(">> Building '{crate_name}'");
            crate::status(&msg);
            println!("{}", msg);

            let mut base_cmd = cmd!(sh, "{cargo} build");
            if flags.release {
                base_cmd = base_cmd.arg("--release");
            } else {
                base_cmd = base_cmd.args(["--profile", "dev-opt"]);
            }
            if flags.no_web {
                // Check if this crate has web features that need modification
                match metadata::get_no_web_features(sh, crate_name)
                    .context("Failed to check web features")?
                {
                    Some(features) => {
                        base_cmd = base_cmd.arg("--no-default-features");
                        if !features.is_empty() {
                            base_cmd = base_cmd.arg("--features");
                            base_cmd = base_cmd.arg(features);
                        }
                    },
                    None => {
                        // Crate doesn't have web features, build normally
                    },
                }
            }
            base_cmd = base_cmd.args(&flags.args);
            base_cmd.run().with_context(err_context)?;
        }
    }

    Ok(())
}

pub fn proto(sh: &Shell) -> anyhow::Result<()> {
    let msg = ">> Generating protobuffer code";
    crate::status(msg);
    println!("{}", msg);

    run_proto_codegen(sh, true);
    Ok(())
}

fn run_proto_codegen(sh: &Shell, force: bool) {
    let zellij_utils_basedir = crate::project_root().join("zellij-utils");
    let _pd = sh.push_dir(&zellij_utils_basedir);

    let specs: &[(&str, &str, &str)] = &[
        (
            "assets/prost_ipc",
            "src/client_server_contract",
            "generated_client_server_api.rs",
        ),
        (
            "assets/prost_web_server",
            "src/web_server_contract",
            "generated_web_server_api.rs",
        ),
        (
            "assets/prost_nested_session",
            "src/nested_session_contract",
            "generated_nested_session_api.rs",
        ),
    ];

    for (out_subdir, src_subdir, include_file) in specs {
        let out_dir = sh.current_dir().join(out_subdir);
        let src_dir = sh.current_dir().join(src_subdir);
        std::fs::create_dir_all(&out_dir).unwrap();

        let last_generated = out_dir
            .join(include_file)
            .metadata()
            .and_then(|m| m.modified());
        let mut proto_files = vec![];
        let mut needs_regeneration = force;

        for entry in std::fs::read_dir(&src_dir).unwrap() {
            let entry_path = entry.unwrap().path();
            if entry_path.is_file()
                && entry_path
                    .extension()
                    .map(|e| e == "proto")
                    .unwrap_or(false)
            {
                let modified = entry_path.metadata().and_then(|m| m.modified());
                needs_regeneration |= match (&last_generated, modified) {
                    (Ok(last_generated), Ok(modified)) => modified > *last_generated,
                    // Couldn't read some metadata, assume needs update
                    _ => true,
                };
                proto_files.push(entry_path.display().to_string());
            }
        }
        proto_files.sort();

        if needs_regeneration {
            let mut prost = prost_build::Config::new();
            prost.out_dir(&out_dir);
            prost.include_file(include_file);
            prost.compile_protos(&proto_files, &[src_dir]).unwrap();
        }
    }
}
