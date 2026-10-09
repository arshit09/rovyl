const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { brandDevElectron } = require("./brand-dev-electron.cjs");

const projectRoot = path.resolve(__dirname, "..");
const distHtml = path.join(projectRoot, "dist", "index.html");
const helperExe = path.join(projectRoot, "resources", "bin", "rovyl-helper.exe");

if (!fs.existsSync(distHtml)) {
  console.log("[Rovyl] Building production assets first...");
  execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });
}

if (!fs.existsSync(helperExe)) {
  require("./build-native-helper.cjs");
}

const env = { ...process.env, NODE_ENV: "production" };
delete env.ELECTRON_RUN_AS_NODE;
const electronPath = require("electron");

console.log("[Rovyl] Starting Rovyl in ultra-lightweight mode (Zero DevServer, Zero Vite)...");

/**
 * Windows takes the running app's name and icon from the executable's PE resources, which on an
 * unpackaged run are still Electron's. Stamp them before the window exists — see the script. It is
 * a no-op once applied, so this costs a pair of `stat`s on every start but the first.
 */
brandDevElectron({ quiet: true }).finally(() => {
  const child = spawn(electronPath, ["."], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });

  child.on("close", (code) => {
    process.exit(code || 0);
  });
});
