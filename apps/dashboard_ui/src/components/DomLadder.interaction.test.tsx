import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { depthPayload } from "../store/fixtures";
import { initialState, type DashboardState } from "../store/types";

const mockUseDashboard = vi.hoisted(() => vi.fn());

// RA-112: DomLadder now reads slices via useDashboardSelector. Derive the
// selector + whole-state hooks from the same mock so existing
// `mockUseDashboard.mockReturnValue({ state })` calls continue to drive it.
vi.mock("../store/context", () => ({
  useDashboard: mockUseDashboard,
  useDashboardState: () => mockUseDashboard().state,
  useDashboardSelector: (selector: (s: DashboardState) => unknown) =>
    selector(mockUseDashboard().state as DashboardState),
}));

import { DomLadder } from "./DomLadder";

function dashboardState(price = 30090.25): DashboardState {
  const state = initialState();
  return {
    ...state,
    price: {
      ...state.price,
      price,
    },
    depth: {
      ...depthPayload(),
      mid: price,
      n_ticks: 3,
    },
  };
}

describe("DOM ladder interactions", () => {
  beforeEach(() => {
    mockUseDashboard.mockReset();
  });

  it("enters manual mode and scrolls by wheel direction only", () => {
    mockUseDashboard.mockReturnValue({ state: dashboardState(30090.25) });
    render(<DomLadder />);

    const rows = screen.getByRole("table", { name: /depth ladder/i });
    expect(screen.queryByText("30092.25")).not.toBeInTheDocument();

    fireEvent.wheel(rows, { deltaY: -999 });

    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("30092.25")).toBeInTheDocument();
  });

  it("keeps manual rows stable across live price ticks until follow is restored", () => {
    mockUseDashboard.mockReturnValue({ state: dashboardState(30090.25) });
    const { rerender } = render(<DomLadder />);

    const rows = screen.getByRole("table", { name: /depth ladder/i });
    fireEvent.keyDown(rows, { key: "ArrowUp" });
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("30091.50")).toBeInTheDocument();

    mockUseDashboard.mockReturnValue({ state: dashboardState(30100.25) });
    rerender(<DomLadder />);

    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("30091.50")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /follow price/i }));
    expect(screen.getByText("Follow")).toBeInTheDocument();
  });
});
