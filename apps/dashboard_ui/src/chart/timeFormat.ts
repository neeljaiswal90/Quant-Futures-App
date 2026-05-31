import type { BusinessDay, Time } from "lightweight-charts";

const PT_TIME_ZONE = "America/Los_Angeles";

const axisFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PT_TIME_ZONE,
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const crosshairFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PT_TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function chartTimeToDate(time: Time): Date {
  if (typeof time === "number") return new Date(time * 1000);
  if (typeof time === "string") return new Date(`${time}T00:00:00Z`);
  return businessDayToDate(time);
}

export function formatChartAxisTimePT(time: Time): string {
  return normalizeMidnightHour(axisFormatter.format(chartTimeToDate(time)));
}

export function formatChartCrosshairTimePT(time: Time): string {
  return `${normalizeMidnightHour(crosshairFormatter.format(chartTimeToDate(time)))} PT`;
}

function businessDayToDate(day: BusinessDay): Date {
  return new Date(Date.UTC(day.year, day.month - 1, day.day));
}

function normalizeMidnightHour(value: string): string {
  // Some Intl implementations render midnight as 24:xx with hour12=false.
  return value.replace(/\b24:/, "00:");
}
