import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const databasePath = process.env.DB_PATH?.trim() || "data/checks.sqlite";
const deleteFalseZero = process.argv.includes("--delete-false-zero");
const db = new Database(databasePath, {
  readonly: !deleteFalseZero,
  create: false,
  strict: true,
});
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

const all = (sql, ...params) => db.query(sql).all(...params);
const get = (sql, ...params) => db.query(sql).get(...params);

const falseZeroPredicate = `
  r.status = 'ok'
  AND r.logged_out = 0
  AND COALESCE(json_extract(r.metrics, '$.balance'), 0) = 0
  AND COALESCE(json_extract(r.metrics, '$.consumed'), 0) = 0
  AND EXISTS (
    SELECT 1
    FROM runs valid
    WHERE valid.account_id = r.account_id
      AND valid.id > r.id
      AND valid.status = 'ok'
      AND valid.logged_out = 1
      AND (
        COALESCE(json_extract(valid.metrics, '$.balance'), 0) > 0
        OR COALESCE(json_extract(valid.metrics, '$.consumed'), 0) > 0
      )
  )
`;

const falseZeroRows = all(`
  SELECT
    r.id,
    r.account_id AS accountId,
    r.started_at AS startedAt,
    r.logged_out AS loggedOut,
    json_extract(r.metrics, '$.balance') AS balance,
    json_extract(r.metrics, '$.consumed') AS consumed,
    json_extract(r.metrics, '$.requestCount') AS requestCount
  FROM runs r
  WHERE ${falseZeroPredicate}
  ORDER BY r.id
`);

let backupPath = null;
let deletedRunIds = [];
if (deleteFalseZero && falseZeroRows.length > 0) {
  const backupDirectory = path.resolve(path.dirname(databasePath), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  backupPath = path.join(backupDirectory, `checks-before-false-zero-cleanup-${stamp}.sqlite`);
  db.query("VACUUM INTO ?").run(backupPath);
  deletedRunIds = falseZeroRows.map((row) => row.id);
  const placeholders = deletedRunIds.map(() => "?").join(", ");
  const remove = db.transaction(() => {
    db.query(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...deletedRunIds);
  });
  remove.immediate();
}

const report = {
  database: path.resolve(databasePath),
  backup: backupPath,
  integrity: get("PRAGMA integrity_check").integrity_check,
  foreignKeyViolations: all("PRAGMA foreign_key_check"),
  counts: Object.fromEntries(
    ["runs", "usage_points", "credit_observations", "credit_grant_events"].map((table) => [
      table,
      get(`SELECT COUNT(*) AS count FROM ${table}`).count,
    ]),
  ),
  falseZeroRows,
  invalidMoneyRows: all(`
    SELECT
      r.id,
      r.account_id AS accountId,
      r.started_at AS startedAt,
      json_extract(r.metrics, '$.balance') AS balance,
      json_extract(r.metrics, '$.consumed') AS consumed
    FROM runs r
    WHERE r.status = 'ok'
      AND (
        json_type(r.metrics, '$.balance') IS NULL
        OR json_type(r.metrics, '$.balance') NOT IN ('integer', 'real')
        OR json_type(r.metrics, '$.consumed') IS NULL
        OR json_type(r.metrics, '$.consumed') NOT IN ('integer', 'real')
        OR CAST(json_extract(r.metrics, '$.consumed') AS REAL) < 0
      )
    ORDER BY r.id
  `),
  deletedRunIds,
  successfulWithoutLogout: all(`
    SELECT id, account_id AS accountId, started_at AS startedAt
    FROM runs
    WHERE status = 'ok' AND logged_out = 0
    ORDER BY id
  `),
  zeroCreditObservations: all(`
    SELECT id, run_id AS runId, account_id AS accountId, observed_at AS observedAt
    FROM credit_observations
    WHERE balance = 0 AND consumed = 0
    ORDER BY id
  `),
  grantTotals: all(`
    SELECT
      account_id AS accountId,
      COUNT(*) AS count,
      SUM(amount) AS amount,
      MIN(occurred_at) AS firstAt,
      MAX(occurred_at) AS lastAt
    FROM credit_grant_events
    GROUP BY account_id
    ORDER BY account_id
  `),
  errorGroups: all(`
    SELECT SUBSTR(error_message, 1, 160) AS error, COUNT(*) AS count
    FROM runs
    WHERE status = 'error'
    GROUP BY SUBSTR(error_message, 1, 160)
    ORDER BY count DESC, error ASC
    LIMIT 30
  `),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
db.close();
