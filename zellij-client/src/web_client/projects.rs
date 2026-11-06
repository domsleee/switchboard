use axum::{http::StatusCode, Json};
use std::path::Path;

// This route sits behind the same authentication as the terminal and session list.
// Resolve home on this computer, never on the computer hosting the sidebar.
pub(super) async fn list() -> Result<Json<Vec<String>>, (StatusCode, &'static str)> {
    let home = std::env::home_dir().ok_or((StatusCode::NOT_FOUND, "Home unavailable"))?;
    folders(&home.join("git"))
        .await
        .map(Json)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Cannot list projects"))
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
}
