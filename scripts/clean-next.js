const fs = require("fs");
const path = require("path");
const p = path.join(__dirname, "..", ".next");
try {
  fs.rmSync(p, { recursive: true, force: true });
  console.log("Removed .next");
} catch (e) {
  if (e.code !== "ENOENT") console.warn(e.message);
}
