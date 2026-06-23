import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalFiles, ffmpeg } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_kidytkghtprejkszddib",
  runtime: "node",
  logLevel: "log",
  build: {
    extensions: [
      ffmpeg(),
      additionalFiles({ files: ["assets/fonts/*.otf", "assets/fonts/*.txt"] }),
    ],
  },
  // The max compute seconds a task is allowed to run. If the task run exceeds this duration, it will be stopped.
  // You can override this on an individual task.
  // See https://trigger.dev/docs/runs/max-duration
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 1,
    },
  },
  dirs: ["./src/trigger"],
});
