const initSqlJs = require('sql.js');
initSqlJs({ locateFile: (f) => require('path').resolve('node_modules/sql.js/dist', f) })
  .then(SQL => {
    const db = new SQL.Database();
    const stmt = db.prepare('SELECT 1 AS a');
    console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(stmt)).sort());
    console.log('methods', Object.keys(stmt));
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
