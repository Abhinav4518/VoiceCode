import initSqlJs, { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { TaskRecord, TaskStore } from '../agent/agent';

export interface Stats {
    tasks: number; successRate: number; avgIterations: number; avgSeconds: number; repaired: number;
}

/**
 * SQLite via sql.js (WebAssembly). better-sqlite3 is a native module compiled for Node, which fails to load
 * inside the Electron-based extension host, so it was replaced. The DB is persisted to disk after every write.
 */
export class StorageManager implements TaskStore {
    private constructor(private readonly db: Database, private readonly file: string) {}

    public static async open(dir: string): Promise<StorageManager> {
        fs.mkdirSync(dir, { recursive: true });                      // the original crashed when this folder didn't exist
        const file = path.join(dir, 'history.db');
        const SQL = await initSqlJs();
        const db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
        db.run(`CREATE TABLE IF NOT EXISTS telemetry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instruction TEXT, iterations INTEGER, success INTEGER, test_status TEXT,
            files_changed INTEGER, duration_ms INTEGER, provider TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        return new StorageManager(db, file);
    }

    public log(r: TaskRecord): void {
        this.db.run(
            'INSERT INTO telemetry (instruction, iterations, success, test_status, files_changed, duration_ms, provider) VALUES (?,?,?,?,?,?,?)',
            [r.instruction, r.iterations, r.success ? 1 : 0, r.testStatus, r.filesChanged, r.durationMs, r.provider]
        );
        fs.writeFileSync(this.file, Buffer.from(this.db.export()));
    }

    /** Metrics for the evaluation chapter: task success rate, repair success, iterations, latency. */
    public stats(): Stats {
        const res = this.db.exec(
            `SELECT COUNT(*), COALESCE(AVG(success),0), COALESCE(AVG(iterations),0), COALESCE(AVG(duration_ms),0) / 1000.0,
                    COALESCE(SUM(CASE WHEN success=1 AND iterations>1 THEN 1 ELSE 0 END),0) FROM telemetry`);
        const [tasks, rate, iters, secs, repaired] = res[0].values[0] as number[];
        return { tasks, successRate: rate, avgIterations: iters, avgSeconds: secs, repaired };
    }

    public close(): void { this.db.close(); }
}
