import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("Unexpected DB client error", err);
});

export const query = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();

export default pool;