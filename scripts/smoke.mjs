import "dotenv/config";
import assert from "node:assert/strict";

const api = `http://127.0.0.1:${process.env.API_PORT || 3000}`;
const web = `http://127.0.0.1:${process.env.WEB_PORT || 4200}`;

for (const base of [api, web]) {
  for (const path of ["/api/health/live", "/api/health/ready"]) {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    assert.equal(
      response.status,
      200,
      `${base}${path}: ${JSON.stringify(body)}`,
    );
    assert.equal(body.status, "ok");
    if (path.endsWith("ready")) {
      for (const name of ["postgres", "redis", "minio"])
        assert.equal(body.services[name].status, "up");
    }
    console.log(`PASS ${base}${path}`);
  }
}

const page = await fetch(web, { signal: AbortSignal.timeout(5000) });
assert.equal(page.status, 200);
assert.match(await page.text(), /efiemipeg/);
console.log("PASS React entry page and Vite-to-API proxy");
