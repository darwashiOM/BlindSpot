import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query('select h3_index, created_at, signage_text from reports');
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/reports_export.json', JSON.stringify(rows, null, 2));
console.log('Wrote data/reports_export.json');
await pool.end();