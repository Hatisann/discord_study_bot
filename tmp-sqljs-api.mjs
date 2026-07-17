import initSqlJs from 'sql.js';
import { resolve } from 'node:path';
const SQL = await initSqlJs({ locateFile: (f) => resolve('node_modules/sql.js/dist', f) });
const db = new SQL.Database();
const stmt = db.prepare('SELECT 1 AS a');
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(stmt)).sort());
console.log('methods', Object.keys(stmt));
