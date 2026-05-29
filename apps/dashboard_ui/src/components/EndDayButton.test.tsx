import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EndDayButton } from "./EndDayButton";

describe("EndDayButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts the end-day shutdown request after confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<EndDayButton />);
    fireEvent.click(screen.getByRole("button", { name: /end day/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/shutdown/end-day", {
        method: "POST",
      });
    });
    expect(screen.getByRole("button", { name: /stopping/i })).toBeDisabled();
  });

  it("does not call the backend when confirmation is cancelled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<EndDayButton />);
    fireEvent.click(screen.getByRole("button", { name: /end day/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /end day/i })).toBeEnabled();
  });

  it("shows a failure status when the shutdown request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<EndDayButton />);
    fireEvent.click(screen.getByRole("button", { name: /end day/i }));

    expect(await screen.findByRole("status")).toHaveTextContent("stop failed");
    expect(screen.getByRole("button", { name: /end day/i })).toBeEnabled();
  });
});
