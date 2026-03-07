/**
 * Kills processes listening on the given ports (Windows-friendly).
 * Usage: node scripts/kill-ports.js [port1] [port2] ...
 * Default: 3000 4000
 */
const { execSync } = require("child_process");
const ports = process.argv.slice(2).map(Number).filter(Boolean);
const toKill = ports.length ? ports : [3000, 4000];
const isWindows = process.platform === "win32";

function killPort(port) {
  try {
    let pids;
    if (isWindows) {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      const lines = out.trim().split(/\r?\n/).filter((l) => l.includes("LISTENING"));
      pids = [...new Set(lines.map((l) => l.trim().split(/\s+/).pop()).filter(Boolean))];
    } else {
      const out = execSync(`lsof -ti :${port}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      pids = out.trim().split(/\s+/).filter(Boolean);
    }
    for (const pid of pids) {
      if (pid && pid !== "0") {
        execSync(isWindows ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`, { stdio: "ignore" });
        console.log(`Killed process ${pid} on port ${port}`);
      }
    }
  } catch (e) {
    if (e.status !== 1) console.warn(`Port ${port}:`, e.message || "no process");
  }
}

toKill.forEach(killPort);
console.log("Ports cleared:", toKill.join(", "));
