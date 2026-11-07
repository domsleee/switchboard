//! Check required skills without tying independently updated plugins to the relay version.
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
// Plugin managers can install a newer revision while an older relay is still
// running. Different text is not evidence that the installed plugin is stale.
pub(super) fn plugin_complete(plugin: &Path) -> bool {
    SKILLS.iter().all(|(name, _)| {
        std::fs::read_to_string(plugin.join("skills").join(name).join("SKILL.md"))
            .is_ok_and(|body| !body.trim().is_empty())
    })
}
