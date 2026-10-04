use crate::{build, flags, metadata, WorkspaceMember};
use anyhow::Context;
use std::path::Path;
use xshell::{cmd, Shell};

pub fn test(sh: &Shell, flags: flags::Test) -> anyhow::Result<()> {
    let err_context = "failed to run task 'test'";

    let _pdo = sh.push_dir(crate::project_root());
    let cargo = crate::cargo().context(err_context)?;

    build::proto(sh).context(err_context)?;

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
