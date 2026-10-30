const { it } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateEnvironment,
} = require("../../../dist/apps/api/config/environment");

const valid = {
  JWT_SECRET: "a".repeat(64),
  WEB_ORIGIN: "http://localhost:4200",
  DATABASE_URL: "postgresql://user:password@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "test-user",
  S3_SECRET_ACCESS_KEY: "test-secret",
  S3_BUCKET: "videos",
};

it("parses numeric settings and applies API defaults", () => {
  assert.equal(validateEnvironment(valid).API_PORT, 3000);
  assert.equal(
    validateEnvironment({ ...valid, API_PORT: "3100" }).API_PORT,
    3100,
  );
});

it("rejects missing secrets, invalid ports, protocols, and origins before startup", () => {
  for (const override of [
    { JWT_SECRET: undefined },
    { JWT_SECRET: "weak-secret" },
    { JWT_TTL_SECONDS: 0 },
    { S3_SECRET_ACCESS_KEY: undefined },
    { API_PORT: "not-a-number" },
    { API_PORT: "70000" },
    { DATABASE_URL: "https://localhost" },
    { REDIS_URL: "https://localhost" },
    { S3_ENDPOINT: "ftp://localhost" },
    { WEB_ORIGIN: "http://localhost:4200/path" },
  ])
    assert.throws(
      () => validateEnvironment({ ...valid, ...override }),
      /Invalid environment/,
    );
});

it("does not expose submitted secret values in validation errors", () => {
  assert.throws(
    () => validateEnvironment({ ...valid, DATABASE_URL: "secret-password" }),
    (error) => {
      assert.ok(error.message.includes("DATABASE_URL"));
      assert.ok(!error.message.includes("secret-password"));
      return true;
    },
  );
});
