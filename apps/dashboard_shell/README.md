# MNQ Dashboard Shell

RA-101 wraps the existing `apps/dashboard_ui` Vite app in a Tauri desktop
window. The dashboard UI remains the source of truth; this package only owns
the desktop shell and native notification runtime.

## Development

```powershell
cd D:\Quant-futures-app\apps\dashboard_shell
npm install
npm run dev
```

Dev mode loads `http://127.0.0.1:5173`, so the existing Vite proxy continues to
serve REST calls to the realtime backend.

## Production Build

```powershell
cd D:\Quant-futures-app\apps\dashboard_shell
npm run build
```

The production shell loads `apps/dashboard_ui/dist` from Tauri's default
`http://tauri.localhost` origin. The UI detects that origin and sends REST calls
directly to `http://127.0.0.1:8765`; WebSocket traffic already targets
`ws://127.0.0.1:8765/ws`.

The shell path should launch the live stack with `-NoDaemon` or an equivalent
shell-specific launcher. `services/notification_daemon` remains in-tree as the
browser-mode fallback.
