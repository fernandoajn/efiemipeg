import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";

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
