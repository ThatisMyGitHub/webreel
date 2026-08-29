import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, extname } from "node:path";
import { TARGET_FPS, DEFAULT_VIEWPORT_SIZE } from "./types.js";
import type { CDPClient, SoundEvent } from "./types.js";
import type { RecordingContext } from "./actions.js";
import { ensureFfmpeg } from "./ffmpeg.js";
import { finalizeMp4, finalizeWebm, finalizeGif, type SfxConfig } from "./media.js";
import type { InteractionTimeline, TimelineData } from "./timeline.js";

/**
 * Convert elapsed recording time into the constant-rate output-frame target
 * required to represent that duration. Deliberately do not cap the result: a
 * slow screenshot or long stall must become held frames in the output rather
 * than silently accelerating the recording.
 */
export function frameSlotsForElapsed(elapsedMs: number, frameMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error(`Invalid elapsed capture time: ${elapsedMs}`);
  }
  if (!Number.isFinite(frameMs) || frameMs <= 0) {
    throw new Error(`Invalid frame duration: ${frameMs}`);
  }
  return Math.max(1, Math.round(elapsedMs / frameMs));
}

export class Recorder {
  private outputPath = "";
  private frameCount = 0;
  private running = false;
  private stopRequested = false;
  private capturePromise: Promise<void> | null = null;
  private events: SoundEvent[] = [];
  private outputWidth: number;
  private outputHeight: number;
  private sfx: SfxConfig | undefined;
  private fps: number;
  private frameMs: number;
  private crf: number;
  private ffmpegPath = "ffmpeg";
  private ffmpegProcess: ChildProcess | null = null;
  private tempVideo = "";
  private drainResolve: (() => void) | null = null;
  private timeline: InteractionTimeline | null = null;
  private ctx: RecordingContext | null = null;
  private framesDir: string | null = null;
  private stopResolve: (() => void) | null = null;
  private stoppedPromise: Promise<void> | null = null;
  private recordingStartedAt = 0;
  private lastFrameBuffer: Buffer | null = null;
  private client: CDPClient | null = null;

  constructor(
    outputWidth = DEFAULT_VIEWPORT_SIZE,
    outputHeight = DEFAULT_VIEWPORT_SIZE,
    options?: { sfx?: SfxConfig; fps?: number; crf?: number; framesDir?: string },
  ) {
    this.outputWidth = outputWidth;
    this.outputHeight = outputHeight;
    this.sfx = options?.sfx;
    this.fps = options?.fps ?? TARGET_FPS;
    this.frameMs = 1000 / this.fps;
    this.crf = options?.crf ?? 18;
    if (options?.framesDir) {
      this.framesDir = options.framesDir;
      mkdirSync(this.framesDir, { recursive: true });
    }
  }

  setTimeline(timeline: InteractionTimeline): void {
    this.timeline = timeline;
  }

  getTimeline(): InteractionTimeline | null {
    return this.timeline;
  }

  getTimelineData(): TimelineData | null {
    return this.timeline?.toJSON() ?? null;
  }

  addEvent(type: "click" | "key") {
    if (this.running) {
      const timeMs = (this.frameCount / this.fps) * 1000;
      this.events.push({ type, timeMs });
    }
  }

  async start(client: CDPClient, outputPath: string, ctx?: RecordingContext) {
    this.ffmpegPath = await ensureFfmpeg();
    this.outputPath = outputPath;
    this.frameCount = 0;
    this.running = true;
    this.stopRequested = false;
    this.events = [];
    this.ctx = ctx ?? null;
    this.client = client;
    this.lastFrameBuffer = null;
    if (this.ctx) this.ctx.setRecorder(this);

    const workDir = resolve(homedir(), ".webreel");
    mkdirSync(workDir, { recursive: true });
    this.tempVideo = resolve(workDir, `_rec_${Date.now()}.mp4`);

    this.ffmpegProcess = spawn(
      this.ffmpegPath,
      [
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
        String(this.fps),
        "-c:v",
        "mjpeg",
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        String(this.crf),
        "-pix_fmt",
        "yuv420p",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-movflags",
        "+faststart",
        "-r",
        String(this.fps),
        this.tempVideo,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const resolveDrain = () => {
      const resolve = this.drainResolve;
      if (resolve) {
        this.drainResolve = null;
        resolve();
      }
    };

    const stdin = this.ffmpegProcess.stdin;
    if (!stdin) throw new Error("ffmpeg process has no stdin pipe");
    stdin.on("drain", resolveDrain);
    this.ffmpegProcess.on("close", resolveDrain);

    this.stoppedPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });

    // Anchor the encoded frame target to a single recording start time. This
    // prevents per-capture/encoder latency from being double-counted and gives
    // stop() an authoritative target for the complete scripted wall clock.
    this.recordingStartedAt = Date.now();
    this.capturePromise = this.captureLoop(client);
  }

  private async writeFrame(buffer: Buffer): Promise<void> {
    if (!this.running) {
      throw new Error("Cannot write a frame after recorder shutdown");
    }
    const stdin = this.ffmpegProcess?.stdin;
    if (!stdin?.writable) {
      throw new Error("ffmpeg stdin is not writable during recording");
    }
    const ok = stdin.write(buffer);
    if (!ok) {
      await new Promise<void>((res) => {
        this.drainResolve = res;
      });
    }
  }

  private async emitFrame(buffer: Buffer): Promise<void> {
    // Only advance overlay/frame accounting after the browser frame has been
    // accepted by ffmpeg. Raw video and timeline therefore cannot diverge when
    // stop() arrives during a catch-up batch.
    await this.writeFrame(buffer);
    if (this.timeline) this.timeline.tick();
    this.frameCount++;

    if (this.framesDir) {
      const padded = String(this.frameCount).padStart(5, "0");
      writeFileSync(resolve(this.framesDir, `frame-${padded}.jpg`), buffer);
    }
  }

  private async emitFramesUntil(targetFrameCount: number, buffer: Buffer): Promise<void> {
    while (this.frameCount < targetFrameCount) {
      await this.emitFrame(buffer);
    }
  }

  private async captureJpeg(client: CDPClient): Promise<Buffer> {
    const result = await client.Page.captureScreenshot({
      format: "jpeg",
      quality: 60,
      optimizeForSpeed: true,
    });
    return Buffer.from(result.data, "base64");
  }

  private async raceStop<T>(promise: Promise<T>): Promise<T | null> {
    const stopped = this.stoppedPromise!.then((): null => null);
    const result = await Promise.race([promise, stopped]);
    return result;
  }

  private async captureLoop(client: CDPClient) {
    let consecutiveErrors = 0;

    while (this.running && !this.stopRequested) {
      try {
        if (!this.timeline) {
          const evalResult = await this.raceStop(
            client.Runtime.evaluate({
              expression: "window.__tickCursor&&window.__tickCursor()",
            }),
          );
          if (!evalResult) break;
        }

        const screenshotResult = await this.raceStop(
          client.Page.captureScreenshot({
            format: "jpeg",
            quality: 60,
            optimizeForSpeed: true,
          }),
        );
        if (!screenshotResult) break;

        const buffer = Buffer.from(screenshotResult.data, "base64");
        const elapsed = Date.now() - this.recordingStartedAt;
        const targetFrameCount = frameSlotsForElapsed(elapsed, this.frameMs);

        // Hold the previous browser sample until the timestamp of this new
        // sample. On the first sample, use the sample itself. This preserves
        // wall-clock ordering instead of back-filling the preceding interval
        // with a browser state that was only observed at its end.
        const heldBuffer = this.lastFrameBuffer ?? buffer;
        await this.emitFramesUntil(targetFrameCount, heldBuffer);
        this.lastFrameBuffer = buffer;
        consecutiveErrors = 0;
      } catch (err) {
        if (this.stopRequested || !this.running) break;
        consecutiveErrors++;
        if (consecutiveErrors >= 10) {
          console.error(
            `Recording aborted after ${consecutiveErrors} consecutive capture failures:`,
            err,
          );
          break;
        }
      }
    }
  }

  getTempVideoPath(): string {
    return this.tempVideo;
  }

  async stop() {
    if (!this.running) return;

    // Capture the requested end of the scripted recording before doing any
    // shutdown work. The final encoded frame target is derived from this time,
    // not from whichever screenshot happened to complete last.
    const recordingStoppedAt = Date.now();
    this.stopRequested = true;

    // Cancel only an in-flight CDP sampling wait. Keep `running` true so any
    // already-started catch-up writes complete and raw/timeline accounting stay
    // aligned.
    if (this.stopResolve) {
      this.stopResolve();
      this.stopResolve = null;
    }

    await this.capturePromise;

    const targetFrameCount = frameSlotsForElapsed(
      Math.max(0, recordingStoppedAt - this.recordingStartedAt),
      this.frameMs,
    );

    // Take an authoritative final browser sample after the concurrent capture
    // loop has stopped. Use it for any unrepresented trailing interval so a
    // slow desktop screenshot cannot erase the final scripted pause/state.
    let finalBuffer = this.lastFrameBuffer;
    if (this.client) {
      try {
        finalBuffer = await this.captureJpeg(this.client);
      } catch (err) {
        console.warn(
          "Failed to capture final recording frame; holding the last successful frame:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (finalBuffer) {
      await this.emitFramesUntil(targetFrameCount, finalBuffer);
      // If the background sampler happened to reach the exact stop target,
      // append one authoritative final-state frame. This changes duration by at
      // most one frame while guaranteeing a visible final browser sample.
      if (this.frameCount === targetFrameCount && finalBuffer !== this.lastFrameBuffer) {
        await this.emitFrame(finalBuffer);
      }
    }

    this.running = false;
    if (this.ctx) this.ctx.setRecorder(null);
    this.client = null;

    if (this.ffmpegProcess) {
      const proc = this.ffmpegProcess;
      const FFMPEG_CLOSE_TIMEOUT_MS = 10_000;
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may have already exited
        }
      }, FFMPEG_CLOSE_TIMEOUT_MS);
      await new Promise<void>((res) => {
        if (proc.exitCode !== null) {
          res();
          return;
        }
        proc.once("close", () => res());
        try {
          proc.stdin?.end();
        } catch (err) {
          console.warn("Failed to close ffmpeg stdin:", err);
          res();
        }
      });
      clearTimeout(killTimer);
      this.ffmpegProcess = null;
    }

    if (this.frameCount === 0) {
      rmSync(this.tempVideo, { force: true });
      return;
    }

    // When a timeline is set, the caller is responsible for the temp video
    // (e.g. renaming it for later compositing). Don't delete or finalize it.
    if (this.timeline) {
      return;
    }

    try {
      const durationSec = this.frameCount / this.fps;
      const ext = extname(this.outputPath).toLowerCase();

      if (ext === ".webm") {
        finalizeWebm(
          this.ffmpegPath,
          this.tempVideo,
          this.outputPath,
          this.events,
          durationSec,
          this.sfx,
        );
      } else if (ext === ".gif") {
        finalizeGif(this.ffmpegPath, this.tempVideo, this.outputPath, this.outputWidth);
      } else {
        finalizeMp4(
          this.ffmpegPath,
          this.tempVideo,
          this.outputPath,
          this.events,
          durationSec,
          { sfx: this.sfx },
        );
      }
    } finally {
      rmSync(this.tempVideo, { force: true });
    }
  }
}
