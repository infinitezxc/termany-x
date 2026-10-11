#[tauri::command]
pub async fn start_file_drag(
    window: tauri::WebviewWindow,
    path: String,
    download_url: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        extern "C" {
            fn termany_start_file_drag(
                view: *mut std::ffi::c_void,
                name: *const std::ffi::c_char,
                source: *const std::ffi::c_char,
                remote: bool,
            ) -> i32;
        }
        let name = path
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .ok_or("Missing file name")?;
        let name = CString::new(name).map_err(|e| e.to_string())?;
        let remote = download_url.is_some();
        if let Some(ref url) = download_url {
            let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("Invalid download URL".into());
            }
        }
        let source = CString::new(download_url.unwrap_or(path)).map_err(|e| e.to_string())?;
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = window.clone();
        window
            .run_on_main_thread(move || {
                let result = handle
                    .ns_view()
                    .map_err(|e| e.to_string())
                    .and_then(|view| {
                        // SAFETY: view is a live NSView and both C strings remain alive
                        // throughout the synchronous main-thread bridge call.
                        match unsafe {
                            termany_start_file_drag(view, name.as_ptr(), source.as_ptr(), remote)
                        } {
                            0 | 1 => Ok(()), // Releasing before IPC arrives cancels the gesture.
                            code => Err(format!("Unable to start file drag ({code})")),
                        }
                    });
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, path, download_url);
        Err("SSH drag-out after drop is currently supported on macOS only".into())
    }
}
