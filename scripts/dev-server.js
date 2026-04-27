const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENTRY_FILE = path.join(ROOT_DIR, "server.js");
const WATCH_DIRS = [
  { target: ROOT_DIR, recursive: false },
  { target: path.join(ROOT_DIR, "public"), recursive: true },
  { target: path.join(ROOT_DIR, "scripts"), recursive: true }
];
const WATCH_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".html",
  ".css"
]);
const WATCH_FILES = new Set([".env", "package.json"]);
const IGNORED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-final",
  "dist-novo",
  "backups",
  "uploads",
  "db"
]);

let child = null;
let restartTimer = null;
let restartPending = false;
let shuttingDown = false;
const watchers = [];

function log(message) {
  console.log(`[dev] ${message}`);
}

function isExpectedNodeVersion() {
  const major = Number(process.versions.node.split(".")[0] || 0);
  return major >= 22 && major < 23;
}

function shouldIgnore(filePath) {
  const relativePath = path.relative(ROOT_DIR, filePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return true;
  }
  if (segments.some((segment) => segment.startsWith(".smoke-runtime-"))) {
    return true;
  }

  const baseName = path.basename(filePath);
  if (baseName.endsWith(".log")) {
    return true;
  }
  if (WATCH_FILES.has(baseName)) {
    return false;
  }

  const extension = path.extname(baseName).toLowerCase();
  return extension ? !WATCH_EXTENSIONS.has(extension) : false;
}

function startServer() {
  child = spawn(process.execPath, [ENTRY_FILE], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "inherit"
  });

  child.once("error", (error) => {
    console.error(`[dev] Failed to start server: ${error.message}`);
  });

  child.once("exit", (code, signal) => {
    child = null;

    if (shuttingDown) {
      return;
    }

    if (restartPending) {
      restartPending = false;
      startServer();
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code}`;
    log(`Server stopped (${reason}). Waiting for changes...`);
  });
}

function stopServer() {
  if (!child) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const currentChild = child;
    const forceKillTimer = setTimeout(() => {
      if (currentChild.exitCode === null && currentChild.signalCode === null) {
        try {
          currentChild.kill("SIGKILL");
        } catch (_) {
          // Process may already be gone.
        }
      }
    }, 5000);

    currentChild.once("exit", () => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    try {
      currentChild.kill("SIGTERM");
    } catch (_) {
      clearTimeout(forceKillTimer);
      resolve();
    }
  });
}

async function restartServer(reason) {
  if (shuttingDown) {
    return;
  }

  log(`Change detected in ${reason}. Restarting...`);

  if (!child) {
    startServer();
    return;
  }

  restartPending = true;
  await stopServer();
}

function scheduleRestart(reason) {
  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartServer(reason).catch((error) => {
      console.error(`[dev] Restart failed: ${error.message}`);
    });
  }, 500);
}

function watchDirectory(target, recursive) {
  if (!fs.existsSync(target)) {
    return;
  }

  try {
    const watcher = fs.watch(target, { recursive }, (eventType, fileName) => {
      if (!fileName) {
        return;
      }

      const resolvedPath = path.resolve(target, String(fileName));
      if (shouldIgnore(resolvedPath)) {
        return;
      }

      const relativePath = path.relative(ROOT_DIR, resolvedPath) || path.basename(resolvedPath);
      scheduleRestart(relativePath);
    });

    watcher.on("error", (error) => {
      console.error(`[dev] Watch error on ${path.relative(ROOT_DIR, target) || "."}: ${error.message}`);
    });

    watchers.push(watcher);
  } catch (error) {
    console.error(`[dev] Could not watch ${path.relative(ROOT_DIR, target) || "."}: ${error.message}`);
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  watchers.forEach((watcher) => watcher.close());
  await stopServer();
  process.exit(signal === "SIGINT" ? 130 : 0);
}

if (!isExpectedNodeVersion()) {
  log(`Warning: package.json expects Node >=22 <23, current version is ${process.version}.`);
}

WATCH_DIRS.forEach(({ target, recursive }) => watchDirectory(target, recursive));

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error(`[dev] Shutdown failed: ${error.message}`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error(`[dev] Shutdown failed: ${error.message}`);
    process.exit(1);
  });
});

startServer();
