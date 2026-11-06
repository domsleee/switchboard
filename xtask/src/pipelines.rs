//! Composite pipelines for the build system.
//!
//! Defines multiple "pipelines" that run specific individual steps in sequence.
use crate::flags;
use crate::{build, format, metadata, test};
use anyhow::Context;
use xshell::{cmd, Shell};

/// Perform a default build.
///
/// Runs the following steps in sequence:
///
/// - format
/// - build
/// - test
pub fn make(sh: &Shell, flags: flags::Make) -> anyhow::Result<()> {
    let err_context = || format!("failed to run pipeline 'make' with args {flags:?}");

    if flags.clean {
        crate::cargo()
            .and_then(|cargo| cmd!(sh, "{cargo} clean").run().map_err(anyhow::Error::new))
            .with_context(err_context)?;
    }

    format::format(sh, flags::Format { check: false })
        .and_then(|_| {
            build::build(
                sh,
                flags::Build {
                    release: flags.release,
                    no_plugins: false,
                    plugins_only: false,
                    no_web: flags.no_web,
                    args: vec![],
                },
            )
        })
        .and_then(|_| {
            test::test(
                sh,
                flags::Test {
                    args: vec![],
                    no_web: flags.no_web,
                },
            )
        })
        .with_context(err_context)
}

/// Generate a runnable executable.
///
/// Runs the following steps in sequence:
///
/// - [`build`](build::build) (native release build)
/// - Copy the executable to [target file](flags::Install::destination)
pub fn install(sh: &Shell, flags: flags::Install) -> anyhow::Result<()> {
    let err_context = || format!("failed to run pipeline 'install' with args {flags:?}");

    // Generate shared protocol types before the native build
    build::proto(sh)
        .and_then(|_| {
            // Build the main executable
            build::build(
                sh,
                flags::Build {
                    release: true,
                    no_plugins: true,
                    plugins_only: false,
                    no_web: flags.no_web,
                    args: flags.args.clone(),
                },
            )
        })
        .with_context(err_context)?;

    // Copy binary to destination
    let destination = if flags.destination.is_absolute() {
        flags.destination.clone()
    } else {
        std::env::current_dir()
            .context("Can't determine current working directory")?
            .join(&flags.destination)
    };
    sh.change_dir(crate::project_root());
    sh.copy_file(
        crate::target_dir().join("release").join("zellij"),
        &destination,
    )
    .with_context(err_context)
}

/// Run zellij debug build.
pub fn run(sh: &Shell, mut flags: flags::Run) -> anyhow::Result<()> {
    let err_context =
        |flags: &flags::Run| format!("failed to run pipeline 'run' with args {:?}", flags);

    if flags.quick_run {
        if flags.data_dir.is_some() {
            eprintln!("cannot use '--data-dir' and '--quick-run' at the same time!");
            std::process::exit(1);
        }
        flags.data_dir.replace(crate::asset_dir());
    }

    let profile = if flags.disable_deps_optimize {
        "dev"
    } else {
        "dev-opt"
    };

    if let Some(ref data_dir) = flags.data_dir {
        let data_dir = sh.current_dir().join(data_dir);
        let features = if flags.no_web {
            ""
        } else {
            "web_server_capability"
        };

        crate::cargo()
            .and_then(|cargo| {
                cmd!(sh, "{cargo} run")
                    .args(["--package", "zellij"])
                    .arg("--no-default-features")
                    .args(["--features", features])
                    .args(["--profile", profile])
                    .args(["--", "--data-dir", &format!("{}", data_dir.display())])
                    .args(&flags.args)
                    .run()
                    .map_err(anyhow::Error::new)
            })
            .with_context(|| err_context(&flags))
    } else {
        build::proto(sh)
            .and_then(|_| crate::cargo())
            .and_then(|cargo| {
                if flags.no_web {
                    // Use dynamic metadata approach to get the correct features
                    match metadata::get_no_web_features(sh, ".")
                        .context("Failed to check web features for main crate")?
                    {
                        Some(features) => {
                            let mut cmd = cmd!(sh, "{cargo} run").args(["--no-default-features"]);

                            if !features.is_empty() {
                                cmd = cmd.args(["--features", &features]);
                            }

                            cmd.args(["--profile", profile])
                                .args(["--"])
                                .args(&flags.args)
                                .run()
                                .map_err(anyhow::Error::new)
                        },
                        None => {
                            // Main crate doesn't have web_server_capability, run normally
                            cmd!(sh, "{cargo} run")
                                .args(["--profile", profile])
                                .args(["--"])
                                .args(&flags.args)
                                .run()
                                .map_err(anyhow::Error::new)
                        },
                    }
                } else {
                    cmd!(sh, "{cargo} run")
                        .args(["--profile", profile])
                        .args(["--"])
                        .args(&flags.args)
                        .run()
                        .map_err(anyhow::Error::new)
                }
            })
            .with_context(|| err_context(&flags))
    }
}
