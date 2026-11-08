//! The skills and custom commands a Claude Code session offers, read from the
//! files Claude loads them from. Claude has no listing command to ask, and
//! reading files spawns nothing, which matters on Windows.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const HEAD_LIMIT: u64 = 64 * 1024;
const CHOICE_LIMIT: usize = 500;
const DESCRIPTION_LIMIT: usize = 200;
const ANCESTOR_LIMIT: usize = 32;
const COMMAND_DEPTH: usize = 4;

type Choices = BTreeMap<String, String>;

pub(super) fn config_dir(home: &Path) -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
}

/// Names and descriptions only: a path never leaves this computer. As in
/// Claude Code, a project's skill wins over a personal one of the same name.
pub(super) fn choices(config: &Path, cwd: Option<&Path>) -> Vec<Value> {
    let mut found = Choices::new();
    let projects = project_dirs(cwd);
    for project in &projects {
        collect(&project.join(".claude"), None, &mut found);
    }
    collect(config, None, &mut found);
    for (plugin, root) in plugins(config, cwd, &projects) {
        collect(&root, Some(&plugin), &mut found);
    }
    found
        .into_iter()
        .take(CHOICE_LIMIT)
        .map(|(name, description)| json!({"name":name,"description":description}))
        .collect()
}

/// The folder and its parents up to the repository root, nearest first.
fn project_dirs(cwd: Option<&Path>) -> Vec<PathBuf> {
    let Some(cwd) = cwd else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    for dir in cwd.ancestors().take(ANCESTOR_LIMIT) {
        dirs.push(dir.to_owned());
        if dir.join(".git").exists() {
            return dirs;
        }
    }
    // Outside a repository only the folder itself is a project.
    dirs.truncate(1);
    dirs
}

fn collect(root: &Path, plugin: Option<&str>, found: &mut Choices) {
    for entry in entries(&root.join("skills")) {
        let Some(text) = head(&entry.join("SKILL.md")) else {
            continue;
        };
        let meta = Meta::parse(&text);
        let name = meta.name.clone().or_else(|| file_name(&entry));
        if let Some(name) = name {
            add(found, plugin, name, meta);
        }
    }
    commands(&root.join("commands"), "", 0, plugin, found);
}

fn commands(dir: &Path, prefix: &str, depth: usize, plugin: Option<&str>, found: &mut Choices) {
    if depth >= COMMAND_DEPTH {
        return;
    }
    for path in entries(dir) {
        let Some(name) = file_name(&path) else {
            continue;
        };
        if path.is_dir() {
            commands(&path, &format!("{prefix}{name}:"), depth + 1, plugin, found);
        } else if let Some(stem) = name.strip_suffix(".md") {
            if let Some(text) = head(&path) {
                let mut meta = Meta::parse(&text);
                // A command's name is its path, whatever its file declares.
                meta.name = None;
                add(found, plugin, format!("{prefix}{stem}"), meta);
            }
        }
    }
}

fn add(found: &mut Choices, plugin: Option<&str>, name: String, meta: Meta) {
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'));
    if !meta.invocable || !valid {
        return;
    }
    let name = match plugin {
        Some(plugin) => format!("{plugin}:{name}"),
        None => name,
    };
    found.entry(name).or_insert(meta.description);
}

fn plugins(config: &Path, cwd: Option<&Path>, projects: &[PathBuf]) -> Vec<(String, PathBuf)> {
    let mut enabled = BTreeMap::new();
    let mut read = |path: PathBuf| {
        if let Some(plugins) = json_file(&path)["enabledPlugins"].as_object() {
            for (key, value) in plugins {
                enabled.insert(key.clone(), value == &Value::Bool(true));
            }
        }
    };
    read(config.join("settings.json"));
    // Nearest last, so that the most specific setting decides.
    for project in projects.iter().rev() {
        read(project.join(".claude/settings.json"));
        read(project.join(".claude/settings.local.json"));
    }
    let installed = json_file(&config.join("plugins/installed_plugins.json"));
    let mut roots = Vec::new();
    for (key, installs) in installed["plugins"].as_object().into_iter().flatten() {
        if enabled.get(key) != Some(&true) {
            continue;
        }
        let name = key.split('@').next().unwrap_or(key).to_owned();
        let install = installs.as_array().into_iter().flatten().find(|install| {
            install["projectPath"]
                .as_str()
                .is_none_or(|project| cwd.is_some_and(|cwd| cwd.starts_with(Path::new(project))))
        });
        if let Some(path) = install.and_then(|install| install["installPath"].as_str()) {
            roots.push((name, PathBuf::from(path)));
        }
    }
    roots
}

fn json_file(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

fn entries(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = read.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    paths
}

fn file_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

fn head(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(HEAD_LIMIT)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

struct Meta {
    name: Option<String>,
    description: String,
    invocable: bool,
}

impl Meta {
    /// Reads the few frontmatter fields needed here, including a description
    /// folded over several lines. Without one, the first line of text describes it.
    fn parse(text: &str) -> Self {
        let mut lines = text
            .strip_prefix('\u{feff}')
            .unwrap_or(text)
            .lines()
            .peekable();
        let mut fields: BTreeMap<String, String> = BTreeMap::new();
        if lines.peek().map(|line| line.trim()) == Some("---") {
            lines.next();
            let mut key: Option<String> = None;
            for line in lines.by_ref() {
                if line.trim() == "---" {
                    break;
                }
                if line.starts_with([' ', '\t']) {
                    if let Some(field) = key.as_ref().and_then(|key| fields.get_mut(key)) {
                        field.push(' ');
                        field.push_str(line.trim());
                    }
                    continue;
                }
                let Some((name, value)) = line.split_once(':') else {
                    key = None;
                    continue;
                };
                let name = name.trim().to_owned();
                let value = value.trim();
                let value = if value.starts_with(['>', '|']) {
                    ""
                } else {
                    value
                        .strip_prefix('"')
                        .and_then(|value| value.strip_suffix('"'))
                        .or_else(|| {
                            value
                                .strip_prefix('\'')
                                .and_then(|value| value.strip_suffix('\''))
                        })
                        .unwrap_or(value)
                };
                fields.insert(name.clone(), value.to_owned());
                key = Some(name);
            }
        }
        let description = fields
            .get("description")
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
            .or_else(|| {
                lines
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .map(|line| line.trim_start_matches('#').trim().to_owned())
            })
            .unwrap_or_default();
        Self {
            name: fields.get("name").filter(|name| !name.is_empty()).cloned(),
            description: description.chars().take(DESCRIPTION_LIMIT).collect(),
            invocable: fields.get("user-invocable").map(String::as_str) != Some("false"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: PathBuf, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn listed(config: &Path, cwd: Option<&Path>) -> Vec<(String, String)> {
        choices(config, cwd)
            .iter()
            .map(|choice| {
                (
                    choice["name"].as_str().unwrap().to_owned(),
                    choice["description"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    #[test]
    fn switchboard_claude_skills_read_folded_descriptions_and_skip_hidden_skills() {
        let meta = Meta::parse(
            "---\nname: bro\ndescription: >\n  Review with\n  a colleague\n---\n# Body\n",
        );
        assert_eq!(meta.name.as_deref(), Some("bro"));
        assert_eq!(meta.description, "Review with a colleague");
        assert!(meta.invocable);
        assert!(!Meta::parse("---\nuser-invocable: false\n---\n").invocable);
        assert_eq!(
            Meta::parse("# Fix the build\n\nMore").description,
            "Fix the build"
        );
    }

    #[test]
    fn switchboard_claude_skills_list_personal_project_and_enabled_plugin_skills() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let repo = temp.path().join("repo");
        let nested = repo.join("crates/one");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&nested).unwrap();
        write(
            config.join("skills/shared/SKILL.md"),
            "---\ndescription: Personal\n---\n",
        );
        write(
            config.join("skills/hidden/SKILL.md"),
            "---\nuser-invocable: false\n---\n",
        );
        write(config.join("commands/group/deploy.md"), "Deploy it\n");
        write(
            repo.join(".claude/skills/shared/SKILL.md"),
            "---\ndescription: Project\n---\n",
        );
        let plugin = temp.path().join("plugin-a");
        write(
            plugin.join("skills/review/SKILL.md"),
            "---\nname: review\ndescription: From a plugin\n---\n",
        );
        let disabled = temp.path().join("plugin-b");
        write(
            disabled.join("skills/off/SKILL.md"),
            "---\ndescription: Disabled\n---\n",
        );
        write(
            config.join("settings.json"),
            r#"{"enabledPlugins":{"tools@market":true,"off@market":false}}"#,
        );
        write(
            config.join("plugins/installed_plugins.json"),
            &json!({"version":2,"plugins":{
                "tools@market":[{"scope":"user","installPath":plugin}],
                "off@market":[{"scope":"user","installPath":disabled}],
            }})
            .to_string(),
        );
        assert_eq!(
            listed(&config, Some(&nested)),
            [
                ("group:deploy".to_owned(), "Deploy it".to_owned()),
                ("shared".to_owned(), "Project".to_owned()),
                ("tools:review".to_owned(), "From a plugin".to_owned()),
            ]
        );
        assert_eq!(
            listed(&config, None)[1],
            ("shared".to_owned(), "Personal".to_owned())
        );
        assert!(!choices(&config, Some(&nested))
            .iter()
            .any(|choice| choice.to_string().contains("SKILL.md")));
    }

    #[test]
    fn switchboard_claude_skills_outside_a_repository_stop_at_the_folder() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let parent = temp.path().join("parent");
        let child = parent.join("child");
        fs::create_dir_all(&child).unwrap();
        write(
            parent.join(".claude/skills/above/SKILL.md"),
            "---\ndescription: Above\n---\n",
        );
        write(
            child.join(".claude/skills/here/SKILL.md"),
            "---\ndescription: Here\n---\n",
        );
        assert_eq!(
            listed(&config, Some(&child)),
            [("here".to_owned(), "Here".to_owned())]
        );
    }
}
