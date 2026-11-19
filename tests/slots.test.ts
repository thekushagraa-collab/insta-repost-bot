import { describe, expect, it } from "vitest";
import { currentPostSlotStart, istDayStart } from "../src/slots";

describe("currentPostSlotStart (India time)", () => {
  it("is 10:00 IST from 10:00 to 18:59", () => {
    expect(currentPostSlotStart(new Date("2026-11-19T04:30:00Z")).toISOString()).toBe("2026-11-19T04:30:00.000Z");
    expect(currentPostSlotStart(new Date("2026-11-19T08:00:00Z")).toISOString()).toBe("2026-11-19T04:30:00.000Z");
  });

  it("is 19:00 IST from 19:00 until 09:59 the next morning", () => {
    expect(currentPostSlotStart(new Date("2026-11-19T13:30:00Z")).toISOString()).toBe("2026-11-19T13:30:00.000Z");
    expect(currentPostSlotStart(new Date("2026-11-19T20:00:00Z")).toISOString()).toBe("2026-11-19T13:30:00.000Z");
    expect(currentPostSlotStart(new Date("2026-11-20T03:00:00Z")).toISOString()).toBe("2026-11-19T13:30:00.000Z");
  });
});

describe("istDayStart", () => {
  it("is midnight India time", () => {
    expect(istDayStart(new Date("2026-11-19T07:52:00Z")).toISOString()).toBe("2026-11-18T18:30:00.000Z");
    expect(istDayStart(new Date("2026-11-19T19:00:00Z")).toISOString()).toBe("2026-11-19T18:30:00.000Z");
  });
});
