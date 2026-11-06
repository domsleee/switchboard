//! Compare the active installed plugin with skills shipped by this relay.
use super::*;

pub(super) const SKILLS: &[(&str, &str)] = &[
    (
        "close-tab",
        include_str!("../../../plugins/switchboard/skills/close-tab/SKILL.md"),
    ),
    (
        "interactive",
        include_str!("../../../plugins/switchboard/skills/interactive/SKILL.md"),
    ),
    (
        "message-board",
        include_str!("../../../plugins/switchboard/skills/message-board/SKILL.md"),
    ),
    (
        "sudo",
        include_str!("../../../plugins/switchboard/skills/sudo/SKILL.md"),
    ),
];
fn digest(body: &str) -> String {
    Sha256::digest(body.replace("\r\n", "\n").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(super) fn plugin_current(plugin: &Path) -> bool {
    SKILLS.iter().all(|(name, expected)| {
        std::fs::read_to_string(plugin.join("skills").join(name).join("SKILL.md"))
            .is_ok_and(|body| digest(&body) == digest(expected))
    })
}
