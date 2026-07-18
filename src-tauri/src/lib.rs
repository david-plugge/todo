#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                // Only one shortcut is registered, so any Pressed event is ours.
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    toggle_quick_add(app);
                }
            })
            .build(),
    );

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                // Cmd/Ctrl + Shift + Space opens the quick-add capture window.
                let quick = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
                app.global_shortcut().register(quick)?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Show/focus the quick-add window, creating it on first use; hide it if already visible.
#[cfg(desktop)]
fn toggle_quick_add<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    if let Some(win) = app.get_webview_window("quick-add") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.center();
            let _ = win.set_focus();
        }
        return;
    }

    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "quick-add",
        tauri::WebviewUrl::App("quickadd".into()),
    )
    .title("Quick Add")
    // A fixed, larger transparent overlay: the capture card sits at the top and
    // its popovers (e.g. the date picker) float over the rest, which stays
    // transparent (the desktop shows through). We never resize the window — the
    // frontend dismisses it on click-away / blur instead. This avoids the
    // `setSize()`-on-undecorated-window bug (tauri#5679, tauri#11975) entirely.
    .inner_size(600.0, 700.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    // On macOS the native shadow of a transparent window traces the opaque
    // pixels, so with a floating popover it draws an ugly L-shaped outline.
    // Disable it — the card carries its own CSS shadow inside the webview.
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .build();
}
