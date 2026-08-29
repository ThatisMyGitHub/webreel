import { describe, expect, it } from "vitest";
import { frameSlotsForElapsed } from "../recorder.js";
import { InteractionTimeline } from "../timeline.js";

const FPS = 60;
const FRAME_MS = 1000 / FPS;

describe("recording wall-clock timing", () => {
  it("preserves slow screenshot intervals instead of capping catch-up frames", () => {
    const elapsedMs = 200;
    const slots = frameSlotsForElapsed(elapsedMs, FRAME_MS);

    expect(slots).toBe(12);

    const timeline = new InteractionTimeline(1440, 900, { fps: FPS });
    for (let i = 0; i < slots; i++) timeline.tick();

    const encodedDurationMs = (timeline.getFrameCount() / FPS) * 1000;
    expect(encodedDurationMs).toBeCloseTo(elapsedMs, 0);
  });

  it("preserves a one-second stall as one second of held output", () => {
    expect(frameSlotsForElapsed(1000, FRAME_MS)).toBe(60);
  });

  it("always emits at least one frame for a valid capture", () => {
    expect(frameSlotsForElapsed(0, FRAME_MS)).toBe(1);
    expect(frameSlotsForElapsed(5, FRAME_MS)).toBe(1);
  });

  it("rejects invalid timing inputs", () => {
    expect(() => frameSlotsForElapsed(-1, FRAME_MS)).toThrow();
    expect(() => frameSlotsForElapsed(Number.NaN, FRAME_MS)).toThrow();
    expect(() => frameSlotsForElapsed(100, 0)).toThrow();
  });

  it("resolves a cursor path only after all encoded-frame ticks consume it", async () => {
    const timeline = new InteractionTimeline(1440, 900, { fps: FPS });
    const complete = timeline.setCursorPath([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 30 },
    ]);

    let resolved = false;
    void complete.then(() => {
      resolved = true;
    });

    timeline.tick();
    timeline.tick();
    await Promise.resolve();
    expect(resolved).toBe(false);

    timeline.tick();
    await complete;
    expect(resolved).toBe(true);
    expect(timeline.toJSON().frames.at(-1)?.cursor).toMatchObject({ x: 30, y: 30 });
  });
});
