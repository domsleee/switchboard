use crate::{build, flags, metadata, WorkspaceMember};
use anyhow::Context;
use std::path::Path;
use xshell::{cmd, Shell};

pub fn test(sh: &Shell, flags: flags::Test) -> anyhow::Result<()> {
    let err_context = "failed to run task 'test'";

    let _pdo = sh.push_dir(crate::project_root());
    let cargo = crate::cargo().context(err_context)?;

    build::proto(sh).context(err_context)?;

    // One cargo run builds the crates they share once, where a run per crate rebuilt
    // them for each crate's features. Without web support each crate needs its own
    // feature list, so those still run one at a time.
    if !flags.no_web {
        let mut cmd = cmd!(sh, "{cargo} test --all-features");
        for WorkspaceMember { crate_name, .. } in crate::workspace_members()
            .iter()
            .filter(|m| !m.crate_name.contains("plugins"))
        {
            let package = if *crate_name == "." {
                "zellij"
            } else {
                crate_name
            };
            cmd = cmd.arg("-p").arg(package);
        }
        return cmd
            .arg("--")
            .args(&flags.args)
            .run()
            .context("Failed to run the workspace tests");
    }

    for WorkspaceMember { crate_name, .. } in crate::workspace_members()
        .iter()
        .filter(|m| !m.crate_name.contains("plugins"))
    {
        let _pd = sh.push_dir(Path::new(crate_name));
        println!();
        let msg = format!(">> Testing '{}'", crate_name);
        crate::status(&msg);
        println!("{}", msg);

        let cmd = if flags.no_web {
            // Check if this crate has web features that need modification
            match metadata::get_no_web_features(sh, crate_name)
                .context("Failed to check web features")?
            {
                Some(features) => {
                    if features.is_empty() {
                        // Crate has web_server_capability but no other applicable features
                        cmd!(sh, "{cargo} test --no-default-features --")
                    } else {
                        cmd!(sh, "{cargo} test --no-default-features --features")
                            .arg(features)
                            .arg("--")
                    }
                },
                None => {
                    // Crate doesn't have web features, use normal test
                    cmd!(sh, "{cargo} test --all-features --")
                },
            }
        } else {
            cmd!(sh, "{cargo} test --all-features --")
        };

        cmd.args(&flags.args)
            .run()
            .with_context(|| format!("Failed to run tests for '{}'", crate_name))?;
    }
    Ok(())
}
