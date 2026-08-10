import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";

const source = resolve(process.env.DB_PATH?.trim() || "data/checks.sqlite");
const timestamp = new Date().toISOString().replaceAll(":", "-");
const target = resolve(process.argv[2] || `data/backups/checks-${timestamp}.sqlite`);

if (source === target) {
  throw new Error("Backup target must be different from the source database.");
}

await mkdir(dirname(target), { recursive: true });
const db = new Database(source, { readonly: true, strict: true });
try {
  const escapedTarget = target.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escapedTarget}'`);
} finally {
  db.close();
}

await chmod(target, 0o600).catch(() => {});
const backup = new Database(target, { readonly: true, strict: true });
try {
  const result = backup.query("PRAGMA integrity_check").get();
  if (!result || Object.values(result)[0] !== "ok") {
    throw new Error(`Backup integrity check failed: ${JSON.stringify(result)}`);
  }
} finally {
  backup.close();
}

console.log(target);
