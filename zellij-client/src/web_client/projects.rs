use axum::{http::StatusCode, Json};
use serde::Deserialize;
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
    let mut projects = folders(&git).await?;
    for root in extra_roots(home).await {
        if same(&root, &git) {
            continue;
        }
        let Ok(names) = folders(&root).await else {
            continue;
        };
        projects.extend(
            names
                .into_iter()
                .map(|name| root.join(name))
                .filter_map(|path| path.to_str().map(str::to_owned)),
        );
    }
    Ok(projects)
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
    let key = |path: &Path| {
        let text = path
            .to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .to_owned();
        if cfg!(windows) {
            text.replace('/', "\\").to_lowercase()
        } else {
            text
        }
    };
    key(left) == key(right)
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
            parts
                .iter()
                .fold(work.clone(), |path, part| path.join(part))
                .to_str()
                .unwrap()
                .to_owned()
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
}
