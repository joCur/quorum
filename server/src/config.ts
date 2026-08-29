import { z } from "zod";

/** Environment configuration — names match `docker-compose.yml` / `.env.example`. */
export const ServerConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  /** Server-side encryption algorithm requested per object (ADR-001). */
  S3_SSE: z.string().default("AES256"),
  /**
   * Development-only fallback that reads tenant and user from request headers
   * until the JWT auth plugin from ticket #3 is wired in.
   */
  RECORDING_ALLOW_HEADER_AUTH: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return ServerConfigSchema.parse(env);
}
