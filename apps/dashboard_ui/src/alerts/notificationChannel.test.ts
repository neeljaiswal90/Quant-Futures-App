import { describe, expect, it } from "vitest";
import { notificationChannelInternals } from "./notificationChannel";

describe("notification channel runtime detection", () => {
  it("does not treat the normal Vite browser origin as Tauri", () => {
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "http://127.0.0.1:5173" },
    });
    try {
      expect(notificationChannelInternals.isTauriRuntime()).toBe(false);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    }
  });

  it("treats Tauri's production custom-protocol origin as Tauri", () => {
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "http://tauri.localhost" },
    });
    try {
      expect(notificationChannelInternals.isTauriRuntime()).toBe(true);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    }
  });
});

