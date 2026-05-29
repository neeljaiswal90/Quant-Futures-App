/**
 * Settings panel — renders + edits the RA-063 AlertConfig shape.
 *
 * Per-tier toggles (enabled / browser_notif / windows_toast / audio_file
 * presence), proximity thresholds, and quiet hours. Save PUTs to /config and
 * tolerates a mock 404 (the edit still applies locally; the user is told it
 * was not persisted).
 */
import { useState } from "react";
import type { AlertConfig, AlertTier } from "@contracts/realtime/config";
import { useAlerts } from "../alerts/AlertProvider";

// Contract consumed type-only (see alerts/config.ts for rationale). This
// tuple mirrors the contract's ALERT_TIERS and is typed as readonly
// AlertTier[] so any contract drift reds the type-check here.
const ALERT_TIERS: readonly AlertTier[] = ["critical", "high", "medium"];

export function SettingsPanel() {
  const { config, setConfig, persist } = useAlerts();
  const [open, setOpen] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const updateTier = (tier: AlertTier, patch: Partial<AlertConfig[AlertTier]>) => {
    setConfig({ ...config, [tier]: { ...config[tier], ...patch } });
  };

  const onSave = async () => {
    const ok = await persist();
    setSaveMsg(ok ? "Saved." : "Applied locally (config endpoint unavailable).");
    setTimeout(() => setSaveMsg(null), 4000);
  };

  return (
    <div className="panel settings">
      <h2
        className="history-toggle"
        onClick={() => setOpen((o) => !o)}
        role="button"
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Alert settings
      </h2>
      {open && (
        <>
          {ALERT_TIERS.map((tier) => {
            const t = config[tier];
            return (
              <div key={tier} style={{ marginBottom: 8 }}>
                <strong style={{ textTransform: "uppercase", fontSize: 12 }}>
                  {tier}
                </strong>
                <dl>
                  <label>
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      onChange={(e) =>
                        updateTier(tier, { enabled: e.target.checked })
                      }
                    />
                    enabled
                  </label>
                  <span />
                  <label>
                    <input
                      type="checkbox"
                      checked={t.audio_file != null}
                      onChange={(e) =>
                        updateTier(tier, {
                          audio_file: e.target.checked ? `${tier}.wav` : null,
                        })
                      }
                    />
                    audio
                  </label>
                  <span />
                  <label>
                    <input
                      type="checkbox"
                      checked={t.browser_notif}
                      onChange={(e) =>
                        updateTier(tier, { browser_notif: e.target.checked })
                      }
                    />
                    browser notif
                  </label>
                  <span />
                  <label>
                    <input
                      type="checkbox"
                      checked={t.windows_toast}
                      onChange={(e) =>
                        updateTier(tier, { windows_toast: e.target.checked })
                      }
                    />
                    windows toast
                  </label>
                  <span />
                </dl>
              </div>
            );
          })}

          <div style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 12 }}>Proximity (pt)</strong>
            <dl>
              <span>critical</span>
              <b>{config.proximity.critical_pt}</b>
              <span>high</span>
              <b>{config.proximity.high_pt}</b>
              <span>medium</span>
              <b>{config.proximity.medium_pt}</b>
            </dl>
          </div>

          <div style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 12 }}>Quiet hours</strong>
            <dl>
              <label>
                <input
                  type="checkbox"
                  checked={config.quiet_hours.enabled}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      quiet_hours: {
                        ...config.quiet_hours,
                        enabled: e.target.checked,
                      },
                    })
                  }
                />
                enabled
              </label>
              <b>
                {config.quiet_hours.start_pt}–{config.quiet_hours.end_pt}
              </b>
            </dl>
          </div>

          <button className="btn btn-primary" onClick={() => void onSave()}>
            Save
          </button>
          {saveMsg && (
            <span className="kv" style={{ marginLeft: 8 }}>
              {saveMsg}
            </span>
          )}
        </>
      )}
    </div>
  );
}
