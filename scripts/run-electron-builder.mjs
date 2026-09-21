import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const explicitOutput = process.env.ZENITH_BUILD_OUTPUT;
const defaultLocalBase =
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

/**
 * Packing inside a OneDrive-synced folder loses to the sync client: it holds handles on files
 * electron-builder is still writing, and placeholder ("cloud-only") files break the asar crawl.
 * So on Windows the output moves out to %LOCALAPPDATA%.
 *
 * That is a Windows-only hazard. On Linux and macOS `LOCALAPPDATA` does not exist and the
 * `AppData\Local` fallback is a meaningless path — and a project checked out under a directory
 * that merely happens to contain "onedrive" in its name would have sent artifacts there. Off
 * Windows the output is always <projectRoot>/build-out.
 */
const shouldRelocateForOneDrive =
  process.platform === "win32" && projectRoot.toLowerCase().includes("onedrive");

const outputDir =
  explicitOutput ||
  (shouldRelocateForOneDrive
    ? path.join(defaultLocalBase, "Zenith OS", "build-out")
    : path.join(projectRoot, "build-out"));

console.log(`electron-builder output: ${outputDir}`);

/**
 * Extra arguments pass straight through to electron-builder. That is how `dist:store` asks for the
 * appx target (`--win appx`) without a second runner or touching the default target.
 */
const forwardedArgs = process.argv.slice(2);
if (forwardedArgs.length) {
  console.log(`electron-builder args: ${forwardedArgs.join(" ")}`);
}

const child = spawn(
  process.execPath,
  [
    path.join(projectRoot, "node_modules", "electron-builder", "cli.js"),
    `--config.directories.output=${outputDir}`,
    ...forwardedArgs,
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
