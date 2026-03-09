/**
 * Kills all Node.js processes (so .next is released) and removes .next.
 * Use when you get EPERM on .next\trace or "operation not permitted".
 * Usage: node scripts/clean-and-kill.js
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const isWindows = process.platform === "win32";

// 1) Kill all node processes
try {
  if (isWindows) {
    const out = execSync('tasklist /fi "imagename eq node.exe" /fo csv /nh', { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const lines = out.trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/"([^"]+)","(\d+)"/);
      if (match) {
        const pid = match[2];
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
          console.log("Killed node process", pid);
        } catch (_) {}
      }
    }
  } else {
    execSync("pkill -f node || true", { stdio: "ignore" });
    console.log("Killed node processes");
  }
} catch (e) {
  // ignore
}

// 2) Wait for handles to release (sync wait on Windows: ping; else sleep 1.5s via child)
try {
  if (isWindows) execSync("ping -n 2 127.0.0.1 > nul", { stdio: "ignore" });
  else execSync("sleep 1.5 2>/dev/null || true", { stdio: "ignore" });
} catch (_) {}

// 3) Remove .next
const p = path.join(__dirname, "..", ".next");
try {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log("Removed .next");
  }
  console.log("Done. Run: npm run dev");
} catch (e) {
  console.warn("Could not remove .next:", e.message);
  console.warn("Close Cursor/VS Code and any app using the project folder, then run: node scripts/clean-and-kill.js");
}
