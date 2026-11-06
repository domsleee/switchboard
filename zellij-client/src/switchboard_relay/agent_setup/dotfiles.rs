//! Checks the local plugin policy written by dotfiles, without host identities.
use super::*;

pub(super) fn inspect(agent: Agent, dir: &Path, policy: &Value) -> Value {
    let Some(policy) = policy.get(agent.id()) else {
        return Value::Null;
    };
    let (Some(required), Some(forbidden)) = (
        policy["required"].as_array(),
        policy["forbidden"].as_array(),
    ) else {
        return json!({"state":"attention", "warnings":["Plugin policy is invalid. Run update-plugins in Nushell."]});
    };
    let mut installed = BTreeMap::new();
    match agent {
        Agent::Codex => {
            let config = std::fs::read_to_string(dir.join("config.toml"))
                .ok()
                .and_then(|text| text.parse::<toml::Table>().ok());
            let config = config.unwrap_or_default();
            if let Some(plugins) = config.get("plugins").and_then(|v| v.as_table()) {
                for (id, settings) in plugins {
                    installed.insert(
                        id.clone(),
                        settings.get("enabled").and_then(|v| v.as_bool()) == Some(true),
                    );
                }
            }
        },
        Agent::Claude | Agent::Copilot => {
            let settings = read_json(&dir.join("settings.json")).unwrap_or(Value::Null);
            if agent == Agent::Claude {
                let registry =
                    read_json(&dir.join("plugins/installed_plugins.json")).unwrap_or(Value::Null);
                if let Some(plugins) = registry["plugins"].as_object() {
                    for (id, entries) in plugins {
                        if entries
                            .as_array()
                            .is_some_and(|entries| !entries.is_empty())
                        {
                            installed.insert(id.clone(), settings["enabledPlugins"][id] != false);
                        }
                    }
                }
            } else {
                let config = read_json(&dir.join("config.json")).unwrap_or(Value::Null);
                if let Some(plugins) = config["installedPlugins"].as_array() {
                    for plugin in plugins {
                        if let (Some(name), Some(market)) =
                            (plugin["name"].as_str(), plugin["marketplace"].as_str())
                        {
                            let id = format!("{name}@{market}");
                            let enabled = plugin["enabled"] != false
                                && settings["enabledPlugins"][&id] != false;
                            installed.insert(id, enabled);
                        }
                    }
                }
            }
        },
    };
    let mut warnings = Vec::new();
    for (id, required) in required
        .iter()
        .map(|id| (id, true))
        .chain(forbidden.iter().map(|id| (id, false)))
    {
        let Some(id) = id.as_str() else {
            warnings.push("Plugin policy is invalid. Run update-plugins in Nushell.".to_string());
            continue;
        };
        match (required, installed.get(id)) {
            (true, None) => warnings.push(format!(
                "{id}: missing on this computer. Run update-plugins in Nushell."
            )),
            (true, Some(false)) => warnings.push(format!(
                "{id}: disabled. Enable this plugin in {}.",
                agent.name()
            )),
            (false, Some(_)) => warnings.push(format!(
                "{id}: not intended for this computer or agent. Remove it from {}.",
                agent.name()
            )),
            _ => {},
        }
    }
    json!({"state": if warnings.is_empty() {"ok"} else {"attention"}, "warnings": warnings})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(agent: Agent, dir: &Path, ids: &[(&str, bool)]) {
        std::fs::create_dir_all(dir).unwrap();
        match agent {
            Agent::Codex => {
                let mut config = "[marketplaces.dotfiles]\nsource_type='local'\n".to_owned();
                for (id, enabled) in ids {
                    config.push_str(&format!("[plugins.'{id}@dotfiles']\nenabled={enabled}\n"));
                }
                std::fs::write(dir.join("config.toml"), config).unwrap();
            },
            Agent::Claude => {
                let plugins: serde_json::Map<String, Value> = ids
                    .iter()
                    .map(|(id, _)| (format!("{id}@dotfiles"), json!([{}])))
                    .collect();
                let enabled: serde_json::Map<String, Value> = ids
                    .iter()
                    .map(|(id, enabled)| (format!("{id}@dotfiles"), json!(enabled)))
                    .collect();
                write_json(
                    &dir.join("plugins/installed_plugins.json"),
                    &json!({"plugins":plugins}),
                )
                .unwrap();
                write_json(
                    &dir.join("settings.json"),
                    &json!({"extraKnownMarketplaces":{"dotfiles":{}}, "enabledPlugins":enabled}),
                )
                .unwrap();
            },
            Agent::Copilot => {
                let plugins: Vec<Value> = ids.iter().map(|(id, enabled)| json!({"name":id,"marketplace":"dotfiles","enabled":enabled})).collect();
                write_json(
                    &dir.join("config.json"),
                    &json!({"installedPlugins":plugins}),
                )
                .unwrap();
                write_json(
                    &dir.join("plugins/known_marketplaces.json"),
                    &json!({"dotfiles":{}}),
                )
                .unwrap();
            },
        }
    }

    fn policy(agent: Agent, work: bool) -> Value {
        let mut required = vec![
            "dotfiles-skills@dotfiles",
            if work {
                "dotfiles-work@dotfiles"
            } else {
                "pr-description-style@dotfiles"
            },
        ];
        let mut forbidden = vec![if work {
            "pr-description-style@dotfiles"
        } else {
            "dotfiles-work@dotfiles"
        }];
        if agent == Agent::Codex {
            required.push("dotfiles-codex@dotfiles");
        } else {
            forbidden.push("dotfiles-codex@dotfiles");
        }
        json!({agent.id(): {"required": required, "forbidden": forbidden}})
    }

    #[test]
    fn switchboard_dotfiles_plugin_local_policy() {
        for agent in Agent::ALL {
            let temp = tempfile::tempdir().unwrap();
            let dir = temp.path();
            assert_eq!(inspect(agent, dir, &Value::Null), Value::Null);
            for work in [false, true] {
                let policy = policy(agent, work);
                let (expected, forbidden) = if work {
                    ("dotfiles-work", "pr-description-style")
                } else {
                    ("pr-description-style", "dotfiles-work")
                };
                let mut ids = vec![("dotfiles-skills", true), (expected, true)];
                if agent == Agent::Codex {
                    ids.push(("dotfiles-codex", true));
                }
                fixture(agent, dir, &ids);
                assert_eq!(
                    inspect(agent, dir, &policy)["state"],
                    "ok",
                    "{agent:?} work={work}"
                );
                ids[1].1 = false;
                fixture(agent, dir, &ids);
                assert!(inspect(agent, dir, &policy)["warnings"][0]
                    .as_str()
                    .unwrap()
                    .contains("disabled"));
                ids.remove(1);
                ids.push((forbidden, false));
                fixture(agent, dir, &ids);
                let report = inspect(agent, dir, &policy);
                assert_eq!(report["warnings"].as_array().unwrap().len(), 2, "{report}");
                assert!(report
                    .to_string()
                    .contains(&format!("{expected}@dotfiles: missing")));
                assert!(report
                    .to_string()
                    .contains(&format!("{forbidden}@dotfiles: not intended")));
            }
            fixture(agent, dir, &[]);
            assert_eq!(
                inspect(agent, dir, &policy(agent, false))["state"],
                "attention"
            );
            assert_eq!(
                inspect(agent, dir, &json!({agent.id():{}}))["state"],
                "attention"
            );
        }
    }
}
