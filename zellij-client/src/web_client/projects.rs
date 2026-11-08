use axum::{http::StatusCode, Json};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

// This route sits behind the same authentication as the terminal and session list.
// Resolve home on this computer, never on the computer hosting the sidebar.
pub(super) async fn list() -> Result<Json<Vec<String>>, (StatusCode, &'static str)> {
    let home = std::env::home_dir().ok_or((StatusCode::NOT_FOUND, "Home unavailable"))?;
    projects(&home)
        .await
        .map(Json)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Cannot list projects"))
}

/// Folders in `~/git` by name, then folders in the extra roots from
/// `~/.config/switchboard/projects.json` by full path. The sidebar sends either
/// form back as the new tab's project, and a full path replaces `~/git` when joined.
async fn projects(home: &Path) -> std::io::Result<Vec<String>> {
    let git = home.join("git");
    let mut roots = vec![git.clone()];
    roots.extend(extra_roots(home).await);
    let mut seen = HashSet::new();
    let mut projects = Vec::new();
    for root in roots {
        let names = match folders(&root).await {
            Ok(names) => names,
            Err(error) if same(&root, &git) => return Err(error),
            Err(_) => continue,
        };
        for name in names {
            let path = root.join(&name);
            let canonical = tokio::fs::canonicalize(&path).await.unwrap_or(path.clone());
            if !seen.insert(path_key(&canonical)) || linked_worktree(&canonical).await {
                continue;
            }
            if same(&root, &git) {
                projects.push(name);
            } else if let Some(path) = path.to_str() {
                // Configured roots may use forward slashes on Windows too.
                projects.push(if cfg!(windows) {
                    path.replace('\\', "/")
                } else {
                    path.to_owned()
                });
            }
        }
    }
    Ok(projects)
}

// A .git file alone also describes submodules and repositories with a separate
// git directory. Only a different common directory identifies a linked worktree.
// Look at ancestors so e.g. a worktree's DotNet folder is excluded as well.
async fn linked_worktree(path: &Path) -> bool {
    for ancestor in path.ancestors() {
        let dot_git = ancestor.join(".git");
        match tokio::fs::metadata(&dot_git).await {
            Ok(metadata) if metadata.is_dir() => return false,
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        }
        let Ok(text) = tokio::fs::read_to_string(&dot_git).await else {
            return false;
        };
        let Some(git_dir) = text.trim().strip_prefix("gitdir:") else {
            return false;
        };
        let git_dir = ancestor.join(git_dir.trim());
        let Ok(common) = tokio::fs::read_to_string(git_dir.join("commondir")).await else {
            return false;
        };
        if common.trim().is_empty() {
            return false;
        }
        let Ok(common) = tokio::fs::canonicalize(git_dir.join(common.trim())).await else {
            return false;
        };
        return tokio::fs::canonicalize(git_dir)
            .await
            .is_ok_and(|git_dir| !same(&git_dir, &common));
    }
    false
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectsFile {
    folders: Vec<String>,
}

/// Each configured folder holds projects. A trailing `*` stands for every folder
/// inside it, for layouts such as `C:\git\GitHub\{org}\{repo}`.
async fn extra_roots(home: &Path) -> Vec<PathBuf> {
    let path = home
        .join(".config")
        .join("switchboard")
        .join("projects.json");
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return vec![],
        Err(error) => {
            log::warn!("Cannot read {}: {error}", path.display());
            return vec![];
        },
    };
    let file = match serde_json::from_str::<ProjectsFile>(&text) {
        Ok(file) => file,
        Err(error) => {
            log::warn!("Ignoring invalid {}: {error}", path.display());
            return vec![];
        },
    };
    let mut roots = Vec::new();
    for folder in file.folders {
        let folder = expand_home(home, folder.trim());
        if folder.file_name().is_some_and(|name| name == "*") {
            let Some(parent) = folder.parent() else {
                continue;
            };
            if let Ok(names) = folders(parent).await {
                roots.extend(names.into_iter().map(|name| parent.join(name)));
            }
        } else {
            roots.push(folder);
        }
    }
    roots
}

fn expand_home(home: &Path, folder: &str) -> PathBuf {
    match folder.strip_prefix('~') {
        // Join part by part, so `~/git` uses this platform's separator throughout.
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => rest
            .split(['/', '\\'])
            .filter(|part| !part.is_empty())
            .fold(home.to_path_buf(), |path, part| path.join(part)),
        _ => PathBuf::from(folder),
    }
}

fn same(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}

fn path_key(path: &Path) -> String {
    let text = path
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_owned();
    if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text
    }
}

async fn folders(root: &Path) -> std::io::Result<Vec<String>> {
    let mut reader = match tokio::fs::read_dir(root).await {
        Ok(reader) => reader,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error),
    };
    let mut names = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        // Follow directory symlinks too: they can be launched just like other projects.
        if tokio::fs::metadata(entry.path())
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            names.push(name);
        }
    }
    names.sort_by_cached_key(|name| name.to_lowercase());
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn project_lookup_lists_only_visible_folders_without_recursing() {
        let root = tempfile::tempdir().unwrap();
        for name in ["switchboard", "Dotfiles", ".hidden", "switchboard/nested"] {
            std::fs::create_dir(root.path().join(name)).unwrap();
        }
        std::fs::write(root.path().join("file.txt"), "not a project").unwrap();
        assert_eq!(
            folders(root.path()).await.unwrap(),
            vec!["Dotfiles", "switchboard"]
        );
        assert!(folders(&root.path().join("missing"))
            .await
            .unwrap()
            .is_empty());
    }

    fn mkdirs(root: &Path, names: &[&str]) {
        for name in names {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
    }

    #[tokio::test]
    async fn project_lookup_adds_configured_folders() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let work = home.join("work");
        mkdirs(
            home,
            &[
                "git/switchboard",
                ".config/switchboard",
                "work/GitHub/Org/Sample",
                "work/GitHub/Org/Sample2",
                "work/GitHub/Org/Sample.Tools3",
                "work/GitHub/Org/Sample-feature",
                "work/GitHub/other/tool",
                "work/GitHub/other/MovedSample",
                "work/extra/notes",
            ],
        );
        let json = serde_json::json!({
            "folders": [work.join("GitHub").join("*"), "~/work/extra", "~/git", "~/missing"]
        });
        std::fs::write(
            home.join(".config/switchboard/projects.json"),
            json.to_string(),
        )
        .unwrap();
        let path = |parts: &[&str]| {
            let path = parts
                .iter()
                .fold(work.clone(), |path, part| path.join(part))
                .to_str()
                .unwrap()
                .to_owned();
            if cfg!(windows) {
                path.replace('\\', "/")
            } else {
                path
            }
        };
        assert_eq!(
            projects(home).await.unwrap(),
            vec![
                "switchboard".to_owned(),
                path(&["GitHub", "Org", "Sample"]),
                path(&["GitHub", "Org", "Sample-feature"]),
                path(&["GitHub", "Org", "Sample.Tools3"]),
                path(&["GitHub", "Org", "Sample2"]),
                path(&["GitHub", "other", "MovedSample"]),
                path(&["GitHub", "other", "tool"]),
                path(&["extra", "notes"]),
            ]
        );
    }

    #[tokio::test]
    async fn project_lookup_ignores_an_invalid_projects_file() {
        let home = tempfile::tempdir().unwrap();
        mkdirs(home.path(), &["git/switchboard", ".config/switchboard"]);
        std::fs::write(
            home.path().join(".config/switchboard/projects.json"),
            r#"{"folder": ["~/git"]}"#,
        )
        .unwrap();
        assert_eq!(projects(home.path()).await.unwrap(), vec!["switchboard"]);
    }

    fn git(root: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn switchboard_project_lookup_filters_real_worktrees_but_keeps_clones_and_git_files() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        mkdirs(
            home,
            &[
                "git/notes",
                ".config/switchboard",
                "work/Sample",
                "work/Sample2/DotNet",
                "work/Separate",
            ],
        );
        let root = home.join("work");
        let main = root.join("Sample");
        git(&main, &["init"]);
        git(&main, &["commit", "--allow-empty", "-m", "Fixture"]);
        let worktree = root.join("ArbitraryName");
        git(
            &main,
            &["worktree", "add", "--detach", worktree.to_str().unwrap()],
        );
        assert!(linked_worktree(&worktree).await);
        // Git also permits a relative gitdir and CRLF in this file.
        std::fs::write(
            worktree.join(".git"),
            "gitdir: ../Sample/.git/worktrees/ArbitraryName\r\n",
        )
        .unwrap();
        std::fs::create_dir(worktree.join("DotNet")).unwrap();
        git(
            &root,
            &["clone", "--local", main.to_str().unwrap(), "Sample-copy"],
        );
        git(&root.join("Sample2"), &["init"]);
        git(
            &root.join("Separate"),
            &[
                "init",
                "--separate-git-dir",
                root.join(".separate-git").to_str().unwrap(),
            ],
        );
        let json = serde_json::json!({"folders": [root, worktree, root.join("Sample2")]});
        std::fs::write(
            home.join(".config/switchboard/projects.json"),
            json.to_string(),
        )
        .unwrap();
        let listed = projects(home).await.unwrap();
        let names: Vec<_> = listed.iter().map(|path| path.replace('\\', "/")).collect();
        assert_eq!(listed.len(), 6, "{listed:?}");
        for suffix in [
            "notes",
            "/Sample",
            "/Sample-copy",
            "/Sample2",
            "/Separate",
            "/Sample2/DotNet",
        ] {
            assert!(
                names.iter().any(|name| name.ends_with(suffix)),
                "Missing {suffix}: {listed:?}"
            );
        }
        assert!(!names.iter().any(|name| name.contains("ArbitraryName")));
    }

    #[tokio::test]
    async fn switchboard_project_lookup_deduplicates_overlapping_roots_and_path_aliases() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        mkdirs(home, &["git/Sample", ".config/switchboard", "work/Other"]);
        let mut roots = vec![
            home.join("git"),
            home.join("work"),
            home.join("work/../work"),
        ];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(home.join("work/Other"), home.join("git/Alias")).unwrap();
        }
        #[cfg(windows)]
        roots.push(PathBuf::from(
            home.join("work").to_string_lossy().to_uppercase(),
        ));
        roots.push(home.join("work"));
        std::fs::write(
            home.join(".config/switchboard/projects.json"),
            serde_json::json!({"folders": roots}).to_string(),
        )
        .unwrap();
        let listed = projects(home).await.unwrap();
        assert_eq!(listed.len(), 2, "{listed:?}");
        assert!(listed.contains(&"Sample".to_owned()));
    }
}
