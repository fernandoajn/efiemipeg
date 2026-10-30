import { copyFile, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";

try {
  await copyFile(
    new URL("../.env.example", import.meta.url),
    new URL("../.env", import.meta.url),
    constants.COPYFILE_EXCL,
  );
  console.log("Created .env with local development settings.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Keeping your existing .env.");
}

const envPath = new URL("../.env", import.meta.url);
let contents = await readFile(envPath, "utf8");
if (!parse(contents).JWT_SECRET) {
  const setting = `JWT_SECRET=${randomBytes(32).toString("hex")}`;
  contents = /^JWT_SECRET=.*$/m.test(contents)
    ? contents.replace(/^JWT_SECRET=.*$/m, setting)
    : `${contents}\n${setting}\n`;
  await writeFile(envPath, contents, { mode: 0o600 });
  console.log("Generated a private JWT signing secret in .env.");
}
