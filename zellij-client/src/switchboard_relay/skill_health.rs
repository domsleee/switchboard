//! Read-only checks of Codex user skills and enabled local marketplace plugins.
//! Remote marketplaces and project-scoped skills need the agent's resolver; do not
//! infer active versions by walking historical cache directories.
use super::*;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

// Bound inspection so large reference trees cannot stall Health polling.
fn fingerprint(root: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    fn visit(
        path: &Path,
        hash: &mut Sha256,
        remaining: &mut u64,
        count: &mut usize,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 12 || *count == 0 {
            return Err("Skill tree exceeds inspection limit".into());
        }
        let mut entries = std::fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .take(*count + 1)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if entries.len() > *count {
            return Err("Skill tree exceeds inspection limit".into());
        }
        *count -= entries.len();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            hash.update((name.len() as u64).to_le_bytes());
            hash.update(name.as_bytes());
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            if meta.is_dir() {
                hash.update(b"directory");
                visit(&entry.path(), hash, remaining, count, depth + 1)?;
                hash.update(b"end-directory");
            } else if meta.is_file() {
                if meta.len() > *remaining {
                    return Err("Skill tree exceeds inspection size limit".into());
                }
                *remaining -= meta.len();
                hash.update(b"file");
                let bytes = bounded_read(&entry.path(), meta.len())?;
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
            } else {
                return Err(format!("Cannot inspect {}", entry.path().display()));
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    visit(root, &mut hash, &mut (16 * 1024 * 1024), &mut 2000, 0)?;
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("{} exceeds inspection limit", path.display()));
    }
    Ok(bytes)
}
fn plugin_skills(plugin: &Path, warnings: &mut Vec<String>) -> BTreeMap<String, (PathBuf, String)> {
    let read = || -> Result<Option<PathBuf>, String> {
        let manifest: Value = serde_json::from_slice(&bounded_read(
            &plugin.join(".codex-plugin/plugin.json"),
            1024 * 1024,
        )?)
        .map_err(|e| e.to_string())?;
        if manifest.get("skills").is_none() {
            return Ok(None);
        }
        let path = manifest["skills"]
            .as_str()
            .ok_or("Unsupported skills directory declaration")?;
        let root = plugin.join(path);
        if !root.is_dir() {
            return Err(format!("Skills directory missing: {}", root.display()));
        }
        Ok(Some(root))
    };
    match read() {
        Ok(Some(root)) => skills(&root, warnings),
        Ok(None) => BTreeMap::new(),
        Err(e) => {
            warnings.push(format!("Cannot inspect {}: {e}", plugin.display()));
            BTreeMap::new()
        },
    }
}

fn skills(root: &Path, warnings: &mut Vec<String>) -> BTreeMap<String, (PathBuf, String)> {
    let mut result = BTreeMap::new();
    if !root.exists() {
        return result;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => {
            warnings.push(format!("{}: {e}", root.display()));
            return result;
        },
    };
    for (index, entry) in entries.take(2001).enumerate() {
        if index == 2000 {
            warnings.push(format!("{} exceeds skill count limit", root.display()));
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                warnings.push(e.to_string());
                continue;
            },
        };
        let path = entry.path().join("SKILL.md");
        if !path.is_file() {
            continue;
        }
        let body = match bounded_read(&path, 1024 * 1024)
            .and_then(|b| String::from_utf8(b).map_err(|e| e.to_string()))
        {
            Ok(body) => body.replace("\r\n", "\n"),
            Err(e) => {
                warnings.push(format!("{}: {e}", path.display()));
                continue;
            },
        };
        let fingerprint = match fingerprint(path.parent().unwrap()) {
            Ok(hash) => hash,
            Err(e) => {
                warnings.push(format!("{}: {e}", path.display()));
                continue;
            },
        };
        // Skill names are declared in the YAML front matter; the folder is a fallback.
        let name = body
            .strip_prefix("---\n")
            .and_then(|s| s.split("\n---").next())
            .and_then(|s| s.lines().find_map(|l| l.strip_prefix("name:")))
            .map(|s| s.trim().trim_matches(['\'', '"']).to_string())
            .unwrap_or_else(|| {
                path.parent()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            });
        result.insert(
            path.parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            (path.clone(), format!("{name}\n{fingerprint}")),
        );
    }
    result
}

type Cached = Option<(PathBuf, PathBuf, std::time::Instant, Value)>;
static CACHE: std::sync::LazyLock<std::sync::Mutex<(u64, Cached)>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new((0, None)));

pub(super) fn codex(dir: &Path, home: &Path) -> Value {
    use std::time::{Duration, Instant};
    let mut cache = CACHE.lock().unwrap();
    if let Some((cached_dir, cached_home, at, value)) = cache.1.as_ref() {
        if cached_dir == dir && cached_home == home && at.elapsed() < Duration::from_secs(60) {
            return value.clone();
        }
    }
    let value = cache.1.as_ref().map(|(_, _, _, v)| v.clone()).unwrap_or_else(
        || json!({"state":"checking", "scope":"Checking Codex skills…", "warnings":[], "refreshPlugins":[]}),
    );
    cache.0 += 1;
    let generation = cache.0;
    cache.1 = Some((
        dir.to_path_buf(),
        home.to_path_buf(),
        Instant::now(),
        value.clone(),
    ));
    let dir = dir.to_path_buf();
    let home = home.to_path_buf();
    std::thread::spawn(move || {
        let value = inspect(&dir, &home);
        publish(generation, dir, home, value);
    });
    value
}

fn publish(generation: u64, dir: PathBuf, home: PathBuf, value: Value) {
    let mut cache = CACHE.lock().unwrap();
    if cache.0 == generation {
        cache.1 = Some((dir, home, std::time::Instant::now(), value));
    }
}

// Invalidate in-flight polling before rechecking a completed repair.
pub(super) fn recheck(dir: &Path, home: &Path) -> Value {
    let generation = {
        let mut cache = CACHE.lock().unwrap();
        cache.0 += 1;
        cache.0
    };
    let value = inspect(dir, home);
    publish(
        generation,
        dir.to_path_buf(),
        home.to_path_buf(),
        value.clone(),
    );
    value
}

pub(super) fn inspect(dir: &Path, home: &Path) -> Value {
    let mut warnings = Vec::<String>::new();
    let mut active = Vec::new();
    let mut refresh_plugins = Vec::new();
    for root in [dir.join("skills"), home.join(".agents/skills")] {
        active.extend(skills(&root, &mut warnings).into_values());
    }

    let config = std::fs::read_to_string(dir.join("config.toml"))
        .map_err(|e| e.to_string())
        .and_then(|s| s.parse::<toml::Table>().map_err(|e| e.to_string()));
    match config {
        Err(e) => warnings.push(format!("Cannot check plugin configuration: {e}")),
        Ok(config) => {
            if let Some(plugins) = config.get("plugins").and_then(|v| v.as_table()) {
                for (id, settings) in plugins {
                    if settings.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
                        continue;
                    }
                    let Some((plugin, market)) = id.rsplit_once('@') else {
                        continue;
                    };
                    // Restrict cache components, never follow arbitrary config paths here.
                    if [plugin, market]
                        .iter()
                        .any(|s| s.is_empty() || s.contains(['/', '\\']) || *s == "..")
                    {
                        continue;
                    }
                    let Some(source) = config.get("marketplaces").and_then(|v| v.get(market))
                    else {
                        continue;
                    };
                    if source.get("source_type").and_then(|v| v.as_str()) != Some("local") {
                        continue;
                    }
                    let Some(base) = source.get("source").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let base = PathBuf::from(base);
                    let manifest =
                        std::fs::read_to_string(base.join(".agents/plugins/marketplace.json"))
                            .ok()
                            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
                    let source = manifest
                        .as_ref()
                        .and_then(|m| m["plugins"].as_array())
                        .and_then(|p| p.iter().find(|p| p["name"] == plugin))
                        .and_then(|p| {
                            p["source"].as_str().or_else(|| {
                                (p["source"]["source"] == "local")
                                    .then(|| p["source"]["path"].as_str())
                                    .flatten()
                            })
                        });
                    let Some(source) = source else {
                        warnings.push(format!("{id}: local marketplace source unavailable"));
                        continue;
                    };
                    let source_root = base.join(source);
                    // Local plugins with a declared version use that cache directory,
                    // not "local". Never select an arbitrary historical cache version.
                    let plugin_manifest =
                        bounded_read(&source_root.join(".codex-plugin/plugin.json"), 1024 * 1024)
                            .ok()
                            .and_then(|s| serde_json::from_slice::<Value>(&s).ok());
                    let version = plugin_manifest
                        .as_ref()
                        .and_then(|m| m["version"].as_str())
                        .unwrap_or("local");
                    if version.is_empty()
                        || version.contains(['/', '\\'])
                        || matches!(version, "." | "..")
                    {
                        warnings.push(format!("{id}: invalid local plugin version"));
                        continue;
                    }
                    let cache_plugin = dir
                        .join("plugins/cache")
                        .join(market)
                        .join(plugin)
                        .join(version);
                    let before_cache = warnings.len();
                    let cache = plugin_skills(&cache_plugin, &mut warnings);
                    let cache_failed = warnings.len() != before_cache;
                    active.extend(cache.clone().into_values());
                    let before_source = warnings.len();
                    let source = plugin_skills(&source_root, &mut warnings);
                    let source_ok = warnings.len() == before_source;
                    let differs = source
                        .iter()
                        .map(|(k, (_, b))| (k, b))
                        .collect::<BTreeMap<_, _>>()
                        != cache
                            .iter()
                            .map(|(k, (_, b))| (k, b))
                            .collect::<BTreeMap<_, _>>();
                    if source_ok && (cache_failed || differs) {
                        refresh_plugins.push(id.clone());
                    }
                    if differs {
                        warnings.push(format!("{id}: cached skills differ from source. Refresh with codex plugin add {id}"));
                    }
                }
            }
        },
    }
    let mut seen = BTreeMap::<String, (PathBuf, String)>::new();
    for (path, text) in active {
        let (name, body) = text.split_once('\n').unwrap();
        if let Some((previous, previous_body)) = seen.get(name) {
            if previous_body != body {
                warnings.push(format!(
                    "Conflicting skill {name}: {} and {}",
                    previous.display(),
                    path.display()
                ));
            }
        } else {
            seen.insert(name.to_string(), (path, body.to_string()));
        }
    }
    json!({"state": if warnings.is_empty() {"ok"} else {"attention"},
        "scope": "Codex user skills and enabled local marketplace plugins; remote and project skills not checked",
        "warnings": warnings, "refreshPlugins": refresh_plugins})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }
    #[test]
    fn switchboard_skill_health_stale_conflicting_and_identical_copies() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let dir = home.join(".codex");
        let source = home.join("source");
        write(&dir.join("config.toml"), &format!("[marketplaces.test]\nsource_type='local'\nsource={:?}\n[plugins.'example@test']\nenabled=true\n", source.to_str().unwrap()));
        write(
            &source.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[{"name":"example","source":"./plugin"}]}"#,
        );
        let skill = "---\nname: example\n---\nCurrent instructions";
        write(
            &source.join("plugin/.codex-plugin/plugin.json"),
            r#"{"skills":"./skills"}"#,
        );
        write(
            &dir.join("plugins/cache/test/example/local/.codex-plugin/plugin.json"),
            r#"{"skills":"./skills"}"#,
        );
        write(&source.join("plugin/skills/example/SKILL.md"), skill);
        let cached = dir.join("plugins/cache/test/example/local/skills/example/SKILL.md");
        write(&cached, "---\nname: example\n---\nOld instructions");
        write(
            &home.join(".agents/skills/different-folder/SKILL.md"),
            skill,
        );
        let report = inspect(&dir, home);
        assert_eq!(report["warnings"].as_array().unwrap().len(), 2);
        assert_eq!(report["refreshPlugins"], json!(["example@test"]));
        assert!(report.to_string().contains("cached skills differ"));
        assert!(report.to_string().contains("Conflicting skill example"));
        write(&cached, skill);
        assert_eq!(inspect(&dir, home)["refreshPlugins"], json!([]));
        assert_eq!(inspect(&dir, home)["state"], "ok");
        write(
            &source.join("plugin/skills/example/reference.txt"),
            "New reference",
        );
        assert_eq!(inspect(&dir, home)["state"], "attention");
        std::fs::remove_file(source.join("plugin/skills/example/reference.txt")).unwrap();
        std::fs::remove_file(&cached).unwrap();
        assert_eq!(inspect(&dir, home)["state"], "attention");
        write(
            &dir.join("config.toml"),
            "[plugins.'example@test']\nenabled=false\n",
        );
        assert_eq!(inspect(&dir, home)["state"], "ok");
    }
    #[test]
    fn switchboard_skill_health_preserves_siblings_and_distinguishes_resource_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(&root.join("good/SKILL.md"), "---\nname: good\n---\nGood");
        write(&root.join("large/SKILL.md"), "Large");
        let file = std::fs::File::create(root.join("large/huge")).unwrap();
        file.set_len(17 * 1024 * 1024).unwrap();
        let mut warnings = Vec::new();
        assert!(skills(root, &mut warnings).contains_key("good"));
        assert!(!warnings.is_empty());
        write(&root.join("good/ab"), "reference");
        let before = fingerprint(&root.join("good")).unwrap();
        std::fs::remove_file(root.join("good/ab")).unwrap();
        write(&root.join("good/a/b"), "reference");
        assert_ne!(before, fingerprint(&root.join("good")).unwrap());
        write(&root.join("tool/.codex-plugin/plugin.json"), "{}");
        warnings.clear();
        assert!(plugin_skills(&root.join("tool"), &mut warnings).is_empty());
        assert!(warnings.is_empty());
    }
    #[test]
    fn switchboard_skill_health_checks_versioned_local_object_sources() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let dir = home.join(".codex");
        let source = home.join("source");
        write(&dir.join("config.toml"), &format!("[marketplaces.test]\nsource_type='local'\nsource={:?}\n[plugins.'example@test']\nenabled=true\n", source.to_str().unwrap()));
        write(
            &source.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[{"name":"example","source":{"source":"local","path":"./plugin"}}]}"#,
        );
        let manifest = r#"{"version":"26.1103.10131","skills":"./skills/"}"#;
        let skill = "---\nname: example\n---\nCurrent instructions";
        write(&source.join("plugin/.codex-plugin/plugin.json"), manifest);
        write(&source.join("plugin/skills/example/SKILL.md"), skill);
        let cache = dir.join("plugins/cache/test/example/26.1103.10131");
        write(&cache.join(".codex-plugin/plugin.json"), manifest);
        write(&cache.join("skills/example/SKILL.md"), skill);
        assert_eq!(inspect(&dir, home)["state"], "ok");
        write(
            &cache.join("skills/example/SKILL.md"),
            "---\nname: example\n---\nStale",
        );
        assert!(inspect(&dir, home)
            .to_string()
            .contains("cached skills differ"));
        std::fs::remove_file(cache.join(".codex-plugin/plugin.json")).unwrap();
        assert!(inspect(&dir, home).to_string().contains("Cannot inspect"));
        assert_eq!(
            inspect(&dir, home)["refreshPlugins"],
            json!(["example@test"])
        );
        std::fs::remove_file(source.join("plugin/.codex-plugin/plugin.json")).unwrap();
        assert_eq!(inspect(&dir, home)["refreshPlugins"], json!([]));
    }
    #[test]
    fn switchboard_skill_health_unreadable_config_is_not_healthy() {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join("config.toml"), "invalid [");
        assert_eq!(inspect(temp.path(), temp.path())["state"], "attention");
    }
}
