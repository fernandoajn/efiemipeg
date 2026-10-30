import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import * as argon2 from "argon2";

const api = `http://127.0.0.1:${process.env.API_PORT || 3000}/api/auth`;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
const marker = randomUUID();
const emails = [
  `smoke-${marker}-a@example.test`,
  `smoke-${marker}-b@example.test`,
];
const password = `smoke-${randomUUID()}`;
async function call(path, { body, cookie } = {}) {
  const response = await fetch(`${api}/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "efiemipeg",
      Origin: process.env.WEB_ORIGIN || "http://localhost:4200",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = response.status === 204 ? null : await response.json();
  return {
    response,
    data,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

try {
  assert.equal((await call("me")).response.status, 401);
  const accounts = [];
  for (const email of emails) {
    const result = await call("register", {
      body: { name: "Smoke Test", email, password },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    assert.ok(result.cookie);
    assert.equal(result.data.user.passwordHash, undefined);
    accounts.push(result);
  }
  const rows = await pool.query(
    'SELECT "passwordHash" FROM "User" WHERE email = ANY($1::text[])',
    [emails],
  );
  assert.equal(rows.rowCount, 2);
  assert.notEqual(rows.rows[0].passwordHash, rows.rows[1].passwordHash);
  for (const row of rows.rows)
    assert.ok(await argon2.verify(row.passwordHash, password));
  console.log(
    "PASS persisted accounts with independently salted Argon2id passwords",
  );
  for (let index = 0; index < accounts.length; index++) {
    const result = await call(`me?userId=${accounts[1 - index].data.user.id}`, {
      cookie: accounts[index].cookie,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.user.email, emails[index]);
  }
  console.log("PASS account isolation and unauthenticated access rejection");
  const duplicate = await call("register", {
    body: { name: "Duplicate", email: emails[0].toUpperCase(), password },
  });
  assert.equal(duplicate.response.status, 409);
  const wrong = await call("login", {
    body: { email: emails[0], password: "incorrect-password" },
  });
  assert.equal(wrong.response.status, 401);
  const login = await call("login", {
    body: { email: emails[0].toUpperCase(), password },
  });
  assert.equal(login.response.status, 200);
  assert.equal(
    (await call("me", { cookie: login.cookie })).response.status,
    200,
  );
  assert.equal(
    (await call("logout", { body: {}, cookie: login.cookie })).response.status,
    204,
  );
  assert.equal(
    (await call("me", { cookie: login.cookie })).response.status,
    401,
  );
  assert.equal(
    (await call("me", { cookie: accounts[1].cookie })).response.status,
    200,
  );
  console.log(
    "PASS duplicate rejection, login, logout revocation, and session independence",
  );
} finally {
  await pool.query('DELETE FROM "User" WHERE email = ANY($1::text[])', [
    emails,
  ]);
  await pool.end();
  console.log("Removed this run’s temporary accounts and sessions.");
}
