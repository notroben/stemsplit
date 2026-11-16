import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const tauriCli = path.join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");

const env = { ...process.env };

if (process.platform === "win32") {
  const rustupHome = "D:\\Programs\\rust\\.rustup";
  const cargoHome = "D:\\Programs\\rust\\.cargo";
  const cacheTmp = path.join(projectRoot, ".cache", "tmp");
  const cargoTarget = path.join(projectRoot, ".cache", "cargo-target");

  if (fs.existsSync(rustupHome) && !env.RUSTUP_HOME) {
    env.RUSTUP_HOME = rustupHome;
  }
  if (fs.existsSync(cargoHome) && !env.CARGO_HOME) {
    env.CARGO_HOME = cargoHome;
  }
  if (fs.existsSync(cacheTmp)) {
    env.TMP = env.TMP && env.TMP.startsWith("D:") ? env.TMP : cacheTmp;
    env.TEMP = env.TEMP && env.TEMP.startsWith("D:") ? env.TEMP : cacheTmp;
  }
  if (!env.CARGO_TARGET_DIR) {
    env.CARGO_TARGET_DIR = cargoTarget;
  }

  const extraPaths = [
    path.join(cargoHome, "bin"),
    "D:\\Programs\\ffmpeg\\bin",
    "C:\\msys64\\mingw64\\bin",
  ].filter((p) => fs.existsSync(p));

  const currentPath = env.PATH ?? env.Path ?? "";
  const existing = new Set(
    currentPath
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => entry.toLowerCase())
  );
  const additions = extraPaths.filter((p) => !existing.has(p.toLowerCase()));
  if (additions.length > 0) {
    env.PATH = [...additions, currentPath].filter(Boolean).join(path.delimiter);
  }
}

const result = spawnSync(process.execPath, [tauriCli, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
