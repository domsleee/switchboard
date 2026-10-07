use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn main() {
    // Track both detached HEADs (CI) and branch refs, including linked worktrees.
    println!("cargo:rerun-if-changed=build.rs");
    for name in ["HEAD", "packed-refs"]
        .into_iter()
        .map(String::from)
        .chain(git(&["symbolic-ref", "-q", "HEAD"]))
    {
        if let Some(path) = git(&["rev-parse", "--git-path", &name]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    for (key, format) in [
        ("SWITCHBOARD_COMMIT", "%h"),
        ("SWITCHBOARD_COMMIT_DATE", "%cs"),
        ("SWITCHBOARD_COMMIT_TIMESTAMP", "%cI"),
    ] {
        println!("cargo:rerun-if-env-changed={key}");
        let value = std::env::var(key)
            .ok()
            .or_else(|| git(&["log", "-1", &format!("--format={format}")]))
            .unwrap_or_else(|| "unknown".into());
        println!("cargo:rustc-env={key}={value}");
    }
}
