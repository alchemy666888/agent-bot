import { z } from "zod";

export const GOOGLE_DRIVE_FOLDER_ID = "1cMXhFmW-bV_JHRRv56ajhWADpM-i-3Wo";
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

const requiredString = z.string().trim().min(1);

const googleDriveSchema = z.object({
  GOOGLE_DRIVE_FOLDER_ID: z.literal(GOOGLE_DRIVE_FOLDER_ID),
  GOOGLE_CLIENT_ID: requiredString,
  GOOGLE_CLIENT_SECRET: requiredString,
  GOOGLE_REFRESH_TOKEN: requiredString,
});

export type GoogleDriveConfig = z.infer<typeof googleDriveSchema>;

export function readGoogleDriveConfig(
  env: Record<string, string | undefined> = process.env,
): GoogleDriveConfig {
  return googleDriveSchema.parse(env);
}

/** Worker env for Drive sync. Local and test processes may omit it. */
export function googleDriveProcessEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!env.GOOGLE_CLIENT_ID) {
    if (env.VERCEL) throw new Error("GOOGLE_DRIVE_CONFIGURATION_INVALID");
    return {};
  }
  const config = readGoogleDriveConfig(env);
  return {
    GOOGLE_DRIVE_FOLDER_ID: config.GOOGLE_DRIVE_FOLDER_ID,
    GOOGLE_CLIENT_ID: config.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: config.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: config.GOOGLE_REFRESH_TOKEN,
  };
}
