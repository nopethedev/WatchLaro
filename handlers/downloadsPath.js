import path from "path";
import fs from "fs";

export const downloadsDir = path.resolve(process.cwd(), "downloads");

// Resolves a stored Files.path value (relative, absolute, or a truncated
// VARCHAR(100) absolute path) to an existing file inside downloads/, or null.
export function resolveStoredFile(storedPath) {
  if (!storedPath || storedPath === "/pending") return null;

  const direct = path.resolve(downloadsDir, storedPath);
  if (direct.startsWith(downloadsDir) && fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    return direct;
  }

  // Truncated absolute paths cut into the middle of the string, so match the
  // file name anywhere under downloads/ as a fallback
  const name = path.basename(storedPath);
  if (!name) return null;

  try {
    for (const entry of fs.readdirSync(downloadsDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name === name) {
        const full = path.join(entry.parentPath ?? entry.path, entry.name);
        if (full.startsWith(downloadsDir)) return full;
      }
    }
  } catch (err) {
    // ignore, treated as not found
  }
  return null;
}