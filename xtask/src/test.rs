use crate::{build, flags, metadata, WorkspaceMember};
use anyhow::Context;
use xshell::{cmd, Shell};

pub fn test(sh: &Shell, flags: flags::Test) -> anyhow::Result<()> {
    let err_context = "failed to run task 'test'";
    let _pd = sh.push_dir(crate::project_root());
    let cargo = crate::cargo().context(err_context)?;
    build::proto(sh).context(err_context)?;

    // Build shared dependencies with one unified feature set, including no-web.
    let mut command = cmd!(sh, "{cargo} test");
    let metadata = if flags.no_web {
        command = command.arg("--no-default-features");
        Some(metadata::get_cargo_metadata(sh)?)
    } else {
        command = command.arg("--all-features");
        None
    };
    let mut features = Vec::new();
    for WorkspaceMember { crate_name, .. } in crate::workspace_members()
        .iter()
        .filter(|m| !m.crate_name.contains("plugins"))
    {
        let package = if *crate_name == "." {
            "zellij"
        } else {
            crate_name
        };
        command = command.arg("-p").arg(package);
        if let Some(metadata) = &metadata {
            if let Some(package_features) = metadata::no_web_features(metadata, crate_name)? {
                features.extend(
                    package_features
                        .split_whitespace()
                        .map(|feature| format!("{package}/{feature}")),
                );
            } else {
                // Preserve all features for a member without web capability.
                let packages = metadata["packages"]
                    .as_array()
                    .context("Expected packages array")?;
                let package_metadata = packages
                    .iter()
                    .find(|p| p["name"] == package)
                    .context("Workspace member missing from metadata")?;
                let package_features = package_metadata["features"]
                    .as_object()
                    .context("Expected features object")?;
                features.extend(
                    package_features
                        .keys()
                        .map(|feature| format!("{package}/{feature}")),
                );
            }
        }
    }
    if !features.is_empty() {
        command = command.arg("--features").arg(features.join(","));
    }
    command
        .arg("--")
        .args(&flags.args)
        .run()
        .context("Failed to run the workspace tests")
}
