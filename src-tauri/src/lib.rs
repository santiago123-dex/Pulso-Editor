use crate::i18n::{tr, trf};
use regex::{NoExpand, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

mod term;
mod userconf;
mod lsp;
mod gitops;
mod githubauth;
mod githubpolicy;
mod githubdevice;
pub mod aichat;
mod cli;
pub mod termchat;
pub mod termui;
pub mod fsguard;
pub mod procguard;
pub mod i18n;
pub mod localai;
pub mod catalog;
pub mod llm;
pub mod agent;
pub mod agenttools;
pub mod agentperms;
pub mod agentconfig;
pub mod agentmem;
mod files;
mod gitinfo;
mod recovery;
mod search;
mod secrets;
mod themes;
mod workspace;

pub(crate) use files::*;
pub(crate) use gitinfo::*;
pub(crate) use recovery::*;
pub(crate) use search::*;
pub(crate) use secrets::*;
pub(crate) use themes::*;
pub(crate) use workspace::*;

mod updates;
mod diag;
mod project_check;
mod test_runner;
mod git_hunks;
mod inline_ai;
mod dap;
mod dap_config;
mod extensions;

/// Los procesos auxiliares no deben abrir ventanas de consola en Windows.
fn background_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command
}

const SKIP_DIRS: [&str; 7] = [".git", "node_modules", "target", "dist", "build", ".next", ".venv"];

/// Normaliza a barras `/` para que el frontend use un solo formato de ruta.
/// Ruta para la interfaz, con `/`. Quita el prefijo «verbatim» de Windows (`\\?\C:\…`, `\\?\UNC\…`)
/// que deja `canonicalize` en las rutas que valida `fsguard`: si no, el explorador, Ctrl+P y la búsqueda
/// devolverían `//?/C:/…` y el mismo archivo se abriría en dos pestañas distintas.
fn norm(p: &Path) -> String {
    let raw = p.to_string_lossy();
    let plain = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(local) = raw.strip_prefix(r"\\?\") {
        local.to_string()
    } else {
        raw.into_owned()
    };
    plain.replace('\\', "/")
}

/// Sufijo del identificador en las compilaciones de desarrollo (sin optimizar: `target/debug/pulso-editor.exe`,
/// `tauri dev`). Con su propio identificador guardan configuración, sesión, copias de recuperación y datos del
/// WebView en otra carpeta, y pueden abrirse a la vez que la versión instalada sin tocar sus datos.
/// Las credenciales del sistema (el token de GitHub) se siguen compartiendo.
pub const DEV_IDENTIFIER_SUFFIX: &str = ".dev";

fn app_context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    if cfg!(debug_assertions) {
        let config = context.config_mut();
        config.identifier = format!("{}{}", config.identifier, DEV_IDENTIFIER_SUFFIX);
    }
    context
}

pub fn run() {
    tauri::Builder::default()
        // Una sola ventana: si se vuelve a lanzar `pulso archivo`, los argumentos llegan a la que ya está abierta.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let targets = cli::parse_args(&args[1.min(args.len())..], std::path::Path::new(&cwd));
            authorize_cli_targets(app, &app.state::<fsguard::WorkspaceGuard>(), &targets);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                // Windows no deja que un proceso en segundo plano robe el foco; subirla un instante por encima del resto sí la trae al frente.
                let _ = w.set_always_on_top(true);
                let _ = w.set_focus();
                let _ = w.set_always_on_top(false);
            }
            let _ = app.emit("cli-open", targets);
        }))
        .manage(fsguard::WorkspaceGuard::default())
        .manage(githubauth::GithubState::default())
        .manage(term::TermState::default())
        .manage(lsp::LspState::default())
        .manage(aichat::AiState::default())
        .manage(catalog::CatalogState::default())
        .manage(std::sync::Arc::new(agentperms::Broker::default()))
        .manage(dap::DapState::default())
        .manage(extensions::ExtensionState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<fsguard::WorkspaceGuard>().remove_window(window.label());
                window.state::<lsp::LspState>().stop_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_workspace_root,
            pick_workspace_folder,
            aichat::project_trust_request,
            open_new_window,
            list_dir,
            cli_startup_targets,
            install_cli_command,
            list_files,
            read_file,
            read_image_file,
            read_theme_file,
            catalog::catalog_get,
            aichat::agent_config,
            agentperms::ai_permission_respond,
            agentperms::agent_rules_list,
            agentperms::agent_rules_remove,
            agentperms::agent_rules_add_deny,
            agentmem::agent_memory_list,
            agentmem::agent_memory_remove,
            catalog::provider_key_set,
            catalog::provider_key_delete,
            pick_theme_file,
            write_file,
            file_mtime,
            backup_write,
            ai_history_read,
            ai_history_write,
            backup_remove,
            backup_list,
            secret_get,
            secret_set,
            secret_delete,
            term::term_shells,
            userconf::terminal_config_files,
            userconf::installed_fonts,
            term::term_spawn,
            term::term_write,
            term::term_resize,
            term::term_kill,
            term::term_kill_all,
            lsp::lsp_host_pid,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            reveal_in_explorer,
            search_files,
            replace_in_file,
            scan_vscode_themes,
            git_status,
            git_remote,
            gitops::git_changes,
            gitops::git_stage,
            gitops::git_unstage,
            gitops::git_commit,
            gitops::git_last_commit_message,
            gitops::git_commit_amend,
            gitops::git_delete_branch,
            gitops::git_rename_branch,
            gitops::git_merge,
            gitops::git_rebase,
            gitops::git_operation_state,
            gitops::git_operation_action,
            gitops::git_diff_sources,
            gitops::git_branches,
            gitops::git_switch,
            gitops::git_discard,
            gitops::git_push,
            gitops::git_pull,
            gitops::git_log,
            gitops::git_commit_files,
            gitops::git_commit_sources,
            gitops::git_blame,
            githubauth::github_init,
            githubauth::github_has_token,
            githubauth::github_set_token,
            githubauth::github_connect,
            githubauth::github_disconnect,
            githubauth::github_api,
            githubauth::open_external,
            githubdevice::github_device_available,
            githubdevice::github_device_start,
            githubdevice::github_device_poll,
            githubdevice::github_device_cancel,
            aichat::ai_detect,
            aichat::ai_detect_provider,
            aichat::ai_detect_all,
            aichat::ai_usage,
            aichat::ai_extra_usage,
            aichat::ai_send,
            aichat::ai_stop,
            aichat::ai_save_image,
            aichat::ai_read_image_data_url,
            aichat::ai_prune_images,
            updates::update_check,
            updates::update_install,
            diag::diag_log,
            diag::diag_collect,
            i18n::i18n_set_lang,
            project_check::project_check,
            test_runner::test_detect,
            test_runner::test_run,
            git_hunks::git_file_hunks,
            git_hunks::git_apply_hunk,
            inline_ai::ai_inline_complete,
            dap::dap_list_configs,
            dap::dap_create_launch_file,
            dap::dap_launch,
            dap::dap_stop,
            dap::dap_set_breakpoints,
            dap::dap_continue,
            dap::dap_next,
            dap::dap_step_in,
            dap::dap_step_out,
            dap::dap_pause,
            dap::dap_stack_trace,
            dap::dap_scopes,
            dap::dap_variables,
            dap::dap_evaluate,
            extensions::ext_list,
            extensions::ext_set_enabled,
            extensions::ext_uninstall,
            extensions::ext_pick_for_install,
            extensions::ext_confirm_install
        ])
        .build(app_context())
        .expect("error al iniciar Pulso Editor")
        .run(|app, event| {
            // Al salir se cierran las terminales, LSP y procesos de IA para no dejar procesos huérfanos.
            if let tauri::RunEvent::Exit = event {
                app.state::<term::TermState>().kill_all();
                app.state::<lsp::LspState>().stop();
                app.state::<aichat::AiState>().stop_all();
                app.state::<dap::DapState>().stop();
            }
        });
}

#[cfg(test)]
mod tests;
