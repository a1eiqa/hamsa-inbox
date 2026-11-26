import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const migrations = new URL('../drizzle/', import.meta.url);

export function openLocalDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');

  function transaction(execute) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = execute();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    transaction(() => {
      if (db.prepare('SELECT name FROM local_migrations WHERE name = ?').get(file)) return;
      db.exec(readFileSync(new URL(file, migrations), 'utf8'));
      db.prepare('INSERT INTO local_migrations VALUES (?)').run(file);
    });
  }

  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      function bound(values) {
        return {
          bind: (...nextValues) => bound(nextValues),
          first: () => statement.get(...values) ?? null,
          all: () => ({ results: statement.all(...values) }),
          run: () => ({ meta: { changes: statement.run(...values).changes } }),
        };
      }
      return bound([]);
    },
    batch(statements) {
      return transaction(() => statements.map((statement) => statement.run()));
    },
    close: () => db.close(),
  };
}
