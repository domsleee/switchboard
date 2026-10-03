//! Native layout coordination. Legacy instruction types remain for IPC compatibility.
//! Switchboard does not execute WebAssembly plugins.
use crate::{
    panes::PaneId, pty::PtyInstruction, route::NotificationEnd,
    session_layout_metadata::SessionLayoutMetadata, thread_bus::Bus, ClientId, ServerInstruction,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
};
use zellij_utils::{
    data::{
        CommandOrPlugin, Event, EventType, FloatingPaneCoordinates, InputMode, LayoutInfo,
        LayoutWithError, MessageToPlugin, PaneRenderReport, PermissionStatus, PermissionType,
    },
    errors::{prelude::*, ContextType, PluginContext},
    input::{
        actions::Action,
        command::TerminalAction,
        keybinds::Keybinds,
        layout::{FloatingPaneLayout, Layout, RunPluginOrAlias, TabLayoutInfo, TiledPaneLayout},
        plugins::PluginAliases,
    },
    pane_size::Size,
};

// Retained for native screen instruction compatibility; no plugin can produce these.
#[derive(Clone, Debug)]
pub struct PluginRenderAsset {
    pub client_id: ClientId,
    pub plugin_id: u32,
    pub bytes: Vec<u8>,
}
pub type PluginId = u32;

#[derive(Clone, Debug)]
pub struct DumpSessionLayoutResponse {
    pub layout_result: Result<String, String>,
    pub metadata: Option<zellij_utils::data::LayoutMetadata>,
}

#[derive(Clone, Debug)]
pub enum PluginInstruction {
    Load(
        Option<bool>,   // should float
        bool,           // should be opened in place
        bool,           // close_replaced_pane
        Option<String>, // pane title
        RunPluginOrAlias,
        Option<usize>,  // tab index
        Option<PaneId>, // pane id to replace if this is to be opened "in-place"
        ClientId,
        Size,
        Option<PathBuf>,  // cwd
        Option<PluginId>, // the focused plugin id if relevant
        bool,             // skip cache
        Option<bool>,     // should focus plugin
        Option<FloatingPaneCoordinates>,
        Option<NotificationEnd>, // completion signal
    ),
    LoadBackgroundPlugin(RunPluginOrAlias, ClientId),
    Update(Vec<(Option<PluginId>, Option<ClientId>, Event)>), // Focused plugin / broadcast, client_id, event data
    Unload(PluginId),                                         // plugin_id
    Reload(
        Option<bool>,   // should float
        Option<String>, // pane title
        RunPluginOrAlias,
        usize, // tab index
        Size,
        Option<NotificationEnd>,
    ),
    ReloadPluginWithId(u32),
    Resize(PluginId, usize, usize), // plugin_id, columns, rows
    AddClient(ClientId),
    RemoveClient(ClientId),
    NewTab(
        Option<PathBuf>,
        Option<TerminalAction>,
        Option<TiledPaneLayout>,
        Vec<FloatingPaneLayout>,
        usize,                        // tab_id
        Option<Vec<CommandOrPlugin>>, // initial_panes
        bool,                         // block_on_first_terminal
        bool,                         // should change focus to new tab
        (ClientId, bool),             // bool -> is_web_client
        Option<NotificationEnd>,      // completion signal
    ),
    OverrideLayout(
        Option<PathBuf>,        // cwd
        Option<TerminalAction>, // default_shell
        Vec<TabLayoutInfo>,     // layouts for each tab
        bool,                   // retain_existing_terminal_panes
        bool,                   // retain_existing_plugin_panes
        ClientId,
        Option<NotificationEnd>,
    ),
    ApplyCachedEvents {
        plugin_ids: Vec<PluginId>,
        done_receiving_permissions: bool,
    },
    ApplyCachedWorkerMessages(PluginId),
    PostMessagesToPluginWorker(
        PluginId,
        ClientId,
        String, // worker name
        Vec<(
            String, // serialized message name
            String, // serialized payload
        )>,
    ),
    PostMessageToPlugin(
        PluginId,
        ClientId,
        String, // serialized message
        String, // serialized payload
    ),
    PluginSubscribedToEvents(PluginId, ClientId, HashSet<EventType>),
    PermissionRequestResult(
        PluginId,
        Option<ClientId>,
        Vec<PermissionType>,
        PermissionStatus,
        Option<PathBuf>,
    ),
    DumpLayout(SessionLayoutMetadata, ClientId, Option<NotificationEnd>),
    ListClientsMetadata(SessionLayoutMetadata, ClientId, Option<NotificationEnd>),
    DumpLayoutToPlugin {
        session_layout_metadata: SessionLayoutMetadata,
        plugin_id: PluginId,
        response_channel: crossbeam::channel::Sender<DumpSessionLayoutResponse>,
    },
    LogLayoutToHd(SessionLayoutMetadata),
    CliPipe {
        pipe_id: String,
        name: String,
        payload: Option<String>,
        plugin: Option<String>,
        args: Option<BTreeMap<String, String>>,
        configuration: Option<BTreeMap<String, String>>,
        floating: Option<bool>,
        pane_id_to_replace: Option<PaneId>,
        pane_title: Option<String>,
        cwd: Option<PathBuf>,
        skip_cache: bool,
        cli_client_id: ClientId,
    },
    KeybindPipe {
        name: String,
        payload: Option<String>,
        plugin: Option<String>,
        args: Option<BTreeMap<String, String>>,
        configuration: Option<BTreeMap<String, String>>,
        floating: Option<bool>,
        pane_id_to_replace: Option<PaneId>,
        pane_title: Option<String>,
        cwd: Option<PathBuf>,
        skip_cache: bool,
        cli_client_id: ClientId,
        plugin_and_client_id: Option<(u32, ClientId)>,
        notification_end: Option<NotificationEnd>,
    },
    CachePluginEvents {
        plugin_id: PluginId,
    },
    MessageFromPlugin {
        source_plugin_id: u32,
        message: MessageToPlugin,
    },
    UnblockCliPipes(Vec<PluginRenderAsset>),
    Reconfigure {
        client_id: ClientId,
        keybinds: Option<Keybinds>,
        default_mode: Option<InputMode>,
        default_shell: Option<TerminalAction>,
        layout_dir: Option<PathBuf>,
        was_written_to_disk: bool,
    },
    FailedToWriteConfigToDisk {
        file_path: Option<PathBuf>,
    },
    WatchFilesystem,
    ListClientsToPlugin(SessionLayoutMetadata, PluginId, ClientId),
    ChangePluginHostDir(PathBuf, PluginId, ClientId),
    WebServerStarted(String), // String -> the base url of the web server
    FailedToStartWebServer(String),
    PaneRenderReport(PaneRenderReport),
    UserInput {
        client_id: ClientId,
        action: Action,
        terminal_id: Option<u32>,
        cli_client_id: Option<ClientId>,
    },
    LayoutListUpdate(Vec<LayoutInfo>, Vec<LayoutWithError>),
    RequestStateUpdateForPlugin(PluginId),
    UpdateSessionSaveTime(u64), // u64 = milliseconds since UNIX epoch
    GetLastSessionSaveTime {
        response_channel: crossbeam::channel::Sender<Option<u64>>,
    },
    DetectPluginConfigChanges(PluginAliases),
    HighlightClicked {
        plugin_id: u32,
        client_id: ClientId,
        pane_id: PaneId,
        pattern: String,
        matched_string: String,
        context: BTreeMap<String, String>,
    },
    Exit,
}

impl From<&PluginInstruction> for PluginContext {
    fn from(plugin_instruction: &PluginInstruction) -> Self {
        match *plugin_instruction {
            PluginInstruction::Load(..) => PluginContext::Load,
            PluginInstruction::LoadBackgroundPlugin(..) => PluginContext::LoadBackgroundPlugin,
            PluginInstruction::Update(..) => PluginContext::Update,
            PluginInstruction::Unload(..) => PluginContext::Unload,
            PluginInstruction::Reload(..) => PluginContext::Reload,
            PluginInstruction::ReloadPluginWithId(..) => PluginContext::ReloadPluginWithId,
            PluginInstruction::Resize(..) => PluginContext::Resize,
            PluginInstruction::Exit => PluginContext::Exit,
            PluginInstruction::AddClient(_) => PluginContext::AddClient,
            PluginInstruction::RemoveClient(_) => PluginContext::RemoveClient,
            PluginInstruction::NewTab(..) => PluginContext::NewTab,
            PluginInstruction::OverrideLayout(..) => PluginContext::OverrideLayout,
            PluginInstruction::ApplyCachedEvents { .. } => PluginContext::ApplyCachedEvents,
            PluginInstruction::ApplyCachedWorkerMessages(..) => {
                PluginContext::ApplyCachedWorkerMessages
            },
            PluginInstruction::PostMessagesToPluginWorker(..) => {
                PluginContext::PostMessageToPluginWorker
            },
            PluginInstruction::PostMessageToPlugin(..) => PluginContext::PostMessageToPlugin,
            PluginInstruction::PluginSubscribedToEvents(..) => {
                PluginContext::PluginSubscribedToEvents
            },
            PluginInstruction::PermissionRequestResult(..) => {
                PluginContext::PermissionRequestResult
            },
            PluginInstruction::DumpLayout(..) => PluginContext::DumpLayout,
            PluginInstruction::ListClientsMetadata(..) => PluginContext::ListClientsMetadata,
            PluginInstruction::LogLayoutToHd(..) => PluginContext::LogLayoutToHd,
            PluginInstruction::CliPipe { .. } => PluginContext::CliPipe,
            PluginInstruction::CachePluginEvents { .. } => PluginContext::CachePluginEvents,
            PluginInstruction::MessageFromPlugin { .. } => PluginContext::MessageFromPlugin,
            PluginInstruction::UnblockCliPipes { .. } => PluginContext::UnblockCliPipes,
            PluginInstruction::WatchFilesystem => PluginContext::WatchFilesystem,
            PluginInstruction::KeybindPipe { .. } => PluginContext::KeybindPipe,
            PluginInstruction::DumpLayoutToPlugin { .. } => PluginContext::DumpLayoutToPlugin,
            PluginInstruction::Reconfigure { .. } => PluginContext::Reconfigure,
            PluginInstruction::FailedToWriteConfigToDisk { .. } => {
                PluginContext::FailedToWriteConfigToDisk
            },
            PluginInstruction::ListClientsToPlugin(..) => PluginContext::ListClientsToPlugin,
            PluginInstruction::ChangePluginHostDir(..) => PluginContext::ChangePluginHostDir,
            PluginInstruction::WebServerStarted(..) => PluginContext::WebServerStarted,
            PluginInstruction::FailedToStartWebServer(..) => PluginContext::FailedToStartWebServer,
            PluginInstruction::PaneRenderReport(..) => PluginContext::PaneRenderReport,
            PluginInstruction::UserInput { .. } => PluginContext::UserInput,
            PluginInstruction::LayoutListUpdate(..) => PluginContext::LayoutListUpdate,
            PluginInstruction::RequestStateUpdateForPlugin(..) => {
                PluginContext::RequestStateUpdateForPlugin
            },
            PluginInstruction::UpdateSessionSaveTime(..) => PluginContext::UpdateSessionSaveTime,
            PluginInstruction::GetLastSessionSaveTime { .. } => {
                PluginContext::GetLastSessionSaveTime
            },
            PluginInstruction::DetectPluginConfigChanges(..) => {
                PluginContext::DetectPluginConfigChanges
            },
            PluginInstruction::HighlightClicked { .. } => PluginContext::HighlightClicked,
        }
    }
}

const PLUGINS_UNSUPPORTED: &str = "Switchboard does not support WebAssembly plugins.";

fn reject_plugin(
    bus: &Bus<PluginInstruction>,
    client_id: ClientId,
    mut completion: Option<NotificationEnd>,
) -> Result<()> {
    if let Some(completion) = completion.as_mut() {
        completion.set_exit_status(2);
        completion.set_error_message(PLUGINS_UNSUPPORTED.to_owned());
    }
    bus.senders.send_to_server(ServerInstruction::LogError(
        vec![PLUGINS_UNSUPPORTED.to_owned()],
        client_id,
        completion,
    ))
}

pub(crate) fn layout_thread_main(
    bus: Bus<PluginInstruction>,
    mut layout: Box<Layout>,
    initiating_client_id: ClientId,
) -> Result<()> {
    layout.remove_plugin_panes();
    let mut clients = vec![initiating_client_id];
    let mut last_session_save_time = None;
    loop {
        let (event, mut err_ctx) = bus
            .recv()
            .context("failed to receive native layout instruction")?;
        err_ctx.add_call(ContextType::Plugin((&event).into()));
        match event {
            PluginInstruction::AddClient(id) => {
                if !clients.contains(&id) {
                    clients.push(id);
                }
            },
            PluginInstruction::RemoveClient(id) => clients.retain(|client| *client != id),
            PluginInstruction::NewTab(
                cwd,
                terminal_action,
                tab_layout,
                mut floating,
                tab_id,
                initial_panes,
                block_on_first_terminal,
                change_focus,
                (client_id, is_web_client),
                completion,
            ) => {
                let client_id = if clients.contains(&client_id) {
                    client_id
                } else {
                    clients.first().copied().unwrap_or(client_id)
                };
                let (default_tiled, default_floating) = layout.new_tab();
                let mut tiled = tab_layout.unwrap_or(default_tiled);
                tiled.remove_plugin_panes();
                if let Some(cwd) = cwd.as_ref() {
                    tiled.add_cwd_to_layout(cwd);
                }
                if floating.is_empty() {
                    floating = default_floating;
                }
                floating.retain(|pane| {
                    !matches!(pane.run, Some(zellij_utils::input::layout::Run::Plugin(_)))
                });
                let initial_panes = initial_panes.map(|panes| {
                    panes
                        .into_iter()
                        .filter(|pane| !matches!(pane, CommandOrPlugin::Plugin(_)))
                        .collect()
                });
                bus.senders.send_to_pty(PtyInstruction::NewTab(
                    cwd,
                    terminal_action,
                    Some(tiled),
                    floating,
                    tab_id,
                    HashMap::new(),
                    initial_panes,
                    block_on_first_terminal,
                    change_focus,
                    (client_id, is_web_client),
                    completion,
                ))?;
            },
            PluginInstruction::OverrideLayout(
                cwd,
                default_shell,
                mut tabs,
                retain_terminals,
                _retain_plugins,
                client_id,
                completion,
            ) => {
                let client_id = if clients.contains(&client_id) {
                    client_id
                } else {
                    clients.first().copied().unwrap_or(client_id)
                };
                for tab in &mut tabs {
                    tab.remove_plugin_panes();
                }
                bus.senders.send_to_pty(PtyInstruction::OverrideLayout(
                    cwd,
                    default_shell,
                    tabs.into_iter().map(|tab| (tab, HashMap::new())).collect(),
                    retain_terminals,
                    false,
                    client_id,
                    completion,
                ))?;
            },
            PluginInstruction::DumpLayout(metadata, client_id, completion) => bus
                .senders
                .send_to_pty(PtyInstruction::DumpLayout(metadata, client_id, completion))?,
            PluginInstruction::ListClientsMetadata(metadata, client_id, completion) => bus
                .senders
                .send_to_pty(PtyInstruction::ListClientsMetadata(
                    metadata, client_id, completion,
                ))?,
            PluginInstruction::LogLayoutToHd(metadata) => bus
                .senders
                .send_to_pty(PtyInstruction::LogLayoutToHd(metadata))?,
            PluginInstruction::UpdateSessionSaveTime(timestamp) => {
                last_session_save_time = Some(timestamp)
            },
            PluginInstruction::GetLastSessionSaveTime { response_channel } => {
                let _ = response_channel.send(last_session_save_time);
            },
            PluginInstruction::Load(
                _,
                _,
                _,
                _,
                _,
                _,
                _,
                client_id,
                _,
                _,
                _,
                _,
                _,
                _,
                completion,
            ) => reject_plugin(&bus, client_id, completion)?,
            PluginInstruction::Reload(_, _, _, _, _, completion) => reject_plugin(
                &bus,
                clients.first().copied().unwrap_or(initiating_client_id),
                completion,
            )?,
            PluginInstruction::CliPipe { cli_client_id, .. } => {
                reject_plugin(&bus, cli_client_id, None)?
            },
            PluginInstruction::KeybindPipe {
                cli_client_id,
                notification_end,
                ..
            } => reject_plugin(&bus, cli_client_id, notification_end)?,
            PluginInstruction::DumpLayoutToPlugin {
                response_channel, ..
            } => {
                let _ = response_channel.send(DumpSessionLayoutResponse {
                    layout_result: Err(PLUGINS_UNSUPPORTED.to_owned()),
                    metadata: None,
                });
            },
            PluginInstruction::LoadBackgroundPlugin(_, client_id) => {
                reject_plugin(&bus, client_id, None)?
            },
            PluginInstruction::Exit => break,
            // Legacy plugin notifications have no subscribers in Switchboard.
            _ => {},
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;
    use zellij_utils::{
        channels::{self, ChannelWithContext, SenderWithContext},
        data::FileToOpen,
    };

    #[test]
    fn new_tab_preserves_files_commands_client_selection_and_completion() {
        let (tx, rx): ChannelWithContext<PluginInstruction> = channels::unbounded();
        let tx = SenderWithContext::new(tx);
        let (pty_tx, pty_rx): ChannelWithContext<PtyInstruction> = channels::unbounded();
        let pty_tx = SenderWithContext::new(pty_tx);
        let bus = Bus::new(vec![rx], None, Some(&pty_tx), None, None, None, None, None);
        let layout = Layout::default_layout_asset();
        let plugin = match layout.new_tab().0.children[0].run.clone().unwrap() {
            zellij_utils::input::layout::Run::Plugin(plugin) => plugin,
            _ => unreachable!(),
        };
        let worker =
            std::thread::spawn(move || layout_thread_main(bus, Box::new(layout), 1).unwrap());
        tx.send(PluginInstruction::AddClient(2)).unwrap();
        tx.send(PluginInstruction::RemoveClient(1)).unwrap();
        let (completion_tx, mut completion_rx) = oneshot::channel();
        tx.send(PluginInstruction::NewTab(
            Some(PathBuf::from("/tmp")),
            None,
            None,
            vec![],
            7,
            Some(vec![
                CommandOrPlugin::new_command(vec!["bash".into()]),
                CommandOrPlugin::File(FileToOpen::new("README.md")),
                CommandOrPlugin::Plugin(plugin),
            ]),
            false,
            true,
            (99, true),
            Some(NotificationEnd::new(completion_tx)),
        ))
        .unwrap();
        tx.send(PluginInstruction::Exit).unwrap();
        worker.join().unwrap();
        match pty_rx.recv().unwrap().0 {
            PtyInstruction::NewTab(
                cwd,
                _,
                tiled,
                floating,
                id,
                plugins,
                initial,
                _,
                _,
                client,
                completion,
            ) => {
                assert_eq!(cwd, Some(PathBuf::from("/tmp")));
                assert_eq!(id, 7);
                assert_eq!(client, (2, true));
                assert!(plugins.is_empty());
                assert!(floating.is_empty());
                assert_eq!(tiled.unwrap().pane_count(), 1);
                let initial = initial.unwrap();
                assert_eq!(initial.len(), 2);
                assert!(matches!(initial[0], CommandOrPlugin::Command(_)));
                assert!(matches!(initial[1], CommandOrPlugin::File(_)));
                assert!(matches!(
                    completion_rx.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty)
                ));
                drop(completion);
                assert!(completion_rx.try_recv().is_ok());
            },
            other => panic!("Unexpected instruction: {other:?}"),
        }
    }
}
