import { Injectable, OnModuleInit } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash!: string;

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomBytes(32).toString("hex"));
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  async verify(hash: string | undefined, password: string): Promise<boolean> {
    // Unknown accounts still pay the same password verification cost.
    const valid = await argon2.verify(hash ?? this.dummyHash, password);
    return Boolean(hash) && valid;
  }
}
