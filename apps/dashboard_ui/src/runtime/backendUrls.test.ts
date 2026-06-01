import { describe, expect, it } from "vitest";
import { defaultBackendUrl, isTauriWebViewOrigin } from "./backendUrls";

describe("backend URL defaults", () => {
  it("keeps browser/dev REST paths relative so Vite proxy can handle them", () => {
    expect(isTauriWebViewOrigin("http://127.0.0.1:5173")).toBe(false);
    expect(defaultBackendUrl("/snapshot")).toBe("/snapshot");
  });

  it("targets the backend directly from the Tauri production origin", () => {
    expect(isTauriWebViewOrigin("http://tauri.localhost")).toBe(true);
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "http://tauri.localhost" },
    });
    try {
      expect(defaultBackendUrl("/api/bookmap-backfill")).toBe(
        "http://127.0.0.1:8765/api/bookmap-backfill",
      );
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    }
  });
});

