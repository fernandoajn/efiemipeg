import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JWT_SECRET: z
    .string()
    .regex(
      /^[a-f0-9]{64,}$/i,
      "Must contain at least 32 random bytes in hex; run npm run setup",
    ),
  JWT_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
  WEB_ORIGIN: z
    .url()
    .refine(
      (value) => new URL(value).origin === value,
      "Must be an origin without a trailing slash or path",
    ),
  DATABASE_URL: z
    .url()
    .refine(
      (value) => /^postgres(ql)?:/.test(value),
      "Must be a PostgreSQL URL",
    ),
  REDIS_URL: z
    .url()
    .refine((value) => /^rediss?:/.test(value), "Must be a Redis URL"),
  S3_ENDPOINT: z
    .url()
    .refine((value) => /^https?:/.test(value), "Must be an HTTP(S) URL"),
  S3_REGION: z.string().min(1),
  S3_PUBLIC_ENDPOINT: z.url().refine(value => /^https?:/.test(value), "Must be an HTTP(S) URL").optional(),
  MAX_VIDEO_BYTES: z.coerce.number().int().min(1).max(2147483647).default(1073741824),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(3600),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(8),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  config: Record<string, unknown>,
): Environment {
  const result = environmentSchema.safeParse(config);
  if (!result.success) {
    // Never include configuration values: they can contain credentials.
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
  }
  return result.data;
}
