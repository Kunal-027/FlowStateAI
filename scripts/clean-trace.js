/**
 * Removes .next/trace (file or dir) to avoid EPERM on Windows when Next.js tries to write to it.
 * Run before dev if you see: EPERM: operation not permitted, open '.next\\trace'
 * Usage: node scripts/clean-trace.js
 */
const fs = require("fs");
const path = require("path");
const tracePath = path.join(__dirname, "..", ".next", "trace");
try {
  if (fs.existsSync(tracePath)) {
    fs.rmSync(tracePath, { recursive: true, force: true });
    console.log("Removed .next/trace");
  }
} catch (e) {
  console.warn("Could not remove .next/trace:", e.message);
  console.warn("Run: npm run dev:fresh (kills processes, removes .next, then starts dev)");
  process.exit(1);
}
