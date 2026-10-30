import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(128, "Use at most 128 characters");
export const registerSchema = z
  .object({
    name: z.string().trim().min(1, "Enter your name").max(80),
    email,
    password,
  })
  .strict();
export const loginSchema = z
  .object({
    email,
    password: z.string().min(1).max(128),
  })
  .strict();

export function validateBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      message: "Check the form and try again.",
      errors: Object.fromEntries(
        result.error.issues.map((issue) => [
          issue.path.join("."),
          issue.message,
        ]),
      ),
    });
  }
  return result.data;
}
