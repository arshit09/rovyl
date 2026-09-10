const path = require("path");
const { spawn } = require("child_process");
const { waitForPort } = require("./wait-for-port.cjs");

/**
 * Standalone Electron launcher, for running Electron against a Vite you started yourself.
 *
 * `npm run dev` in one terminal and `npm run electron` in another is still the way to drive the
 * two halves separately. The waiting and the NODE_ENV that `wait-on` and `cross-env` used to do
 * from the npm script now live here, so the script is a plain `node` invocation and the two
 * packages are gone from the tree. `npm start` does not come through here — it uses
 * `scripts/dev-runtime.cjs`, which supervises both children together.
 */
const DEV_PORT = 5173;
const projectRoot = path.join(__dirname, "..");

(async () => {
  if (!(await waitForPort(DEV_PORT))) {
    console.error(`Nothing is listening on ${DEV_PORT}. Start Vite first with \`npm run dev\`.`);
    process.exit(1);
  }

  // CRITICAL FIX: Unset ELECTRON_RUN_AS_NODE to prevent Electron from running as a plain Node process.
  // This allows Electron to load its internal API (app, BrowserWindow, etc.) correctly.
  const env = { ...process.env, NODE_ENV: "development" };
  if (env.ELECTRON_RUN_AS_NODE) {
    console.log("Sanitizing environment: Removing ELECTRON_RUN_AS_NODE");
    delete env.ELECTRON_RUN_AS_NODE;
  }

  const electron = require("electron");
  const child = spawn(electron, ["."], {
    stdio: "inherit",
    env,
    cwd: projectRoot, // Ensure cwd is project root
  });

  child.on("close", (code) => {
    console.log(`Electron process exited with code ${code}`);
    process.exit(code);
  });
})();
