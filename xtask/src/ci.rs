//! Tasks related to zellij CI
use crate::{
    assets, build,
    flags::{self, BuildRelease, CiCmd, Cross},
    metadata,
};
use anyhow::Context;
use std::{ffi::OsString, path::PathBuf};
use xshell::{cmd, Shell};

pub fn main(sh: &Shell, flags: flags::Ci) -> anyhow::Result<()> {
    let err_context = "failed to run CI task";

    match flags.subcommand {
        CiCmd::Cross(Cross { triple, no_web }) => cross_compile(sh, &triple, no_web),
        CiCmd::BuildRelease(BuildRelease { no_web }) => build_release(sh, no_web),
    }
    .context(err_context)
}

/// Native release build: generates protobufs, and runs
/// `cargo build --release` without cross-compilation.
fn build_release(sh: &Shell, no_web: bool) -> anyhow::Result<()> {
    let err_context = "failed to perform native release build";

    assets::assets(sh, flags::Assets { check: true }).context(err_context)?;

    // Generate protobufs
    build::proto(sh).context(err_context)?;

    // Build the main binary natively
    let _pd = sh.push_dir(crate::project_root());
    crate::cargo()
        .and_then(|cargo| {
            if no_web {
                match metadata::get_no_web_features(sh, ".")
                    .context("Failed to check web features for build-release")?
                {
                    Some(features) => {
                        let mut cmd = cmd!(
                            sh,
                            "{cargo} build --verbose --release --no-default-features"
                        );
                        if !features.is_empty() {
                            cmd = cmd.arg("--features").arg(features);
                        }
                        cmd.run().map_err(anyhow::Error::new)
                    },
                    None => cmd!(sh, "{cargo} build --verbose --release")
                        .run()
                        .map_err(anyhow::Error::new),
                }
            } else {
                cmd!(sh, "{cargo} build --verbose --release")
                    .run()
                    .map_err(anyhow::Error::new)
            }
        })
        .context(err_context)
}

fn cross_compile(sh: &Shell, target: &OsString, no_web: bool) -> anyhow::Result<()> {
    let err_context = || format!("failed to cross-compile for {target:?}");

    crate::cargo()
        .and_then(|cargo| {
            cmd!(sh, "{cargo} install cross")
                .run()
                .map_err(anyhow::Error::new)
        })
        .with_context(err_context)?;

    build::proto(sh).with_context(err_context)?;

    cross()
        .and_then(|cross| {
            if no_web {
                match metadata::get_no_web_features(sh, ".")
                    .context("Failed to check web features for cross compilation")?
                {
                    Some(features) => {
                        let mut cmd = cmd!(sh, "{cross} build --verbose --release --target {target} --no-default-features");
                        if !features.is_empty() {
                            cmd = cmd.arg("--features").arg(features);
                        }
                        cmd.run().map_err(anyhow::Error::new)
                    },
                    None => {
                        // Main crate doesn't have web_server_capability, build normally
                        cmd!(sh, "{cross} build --verbose --release --target {target}")
                            .run()
                            .map_err(anyhow::Error::new)
                    },
                }
            } else {
                cmd!(sh, "{cross} build --verbose --release --target {target}")
                    .run()
                    .map_err(anyhow::Error::new)
            }
        })
        .with_context(err_context)
}

fn cross() -> anyhow::Result<PathBuf> {
    match which::which("cross") {
        Ok(path) => Ok(path),
        Err(e) => {
            eprintln!("!! 'cross' wasn't found but is needed for this build step.");
            eprintln!("!! Please install it with: `cargo install cross`");
            Err(e).context("couldn't find 'cross' executable")
        },
    }
}
