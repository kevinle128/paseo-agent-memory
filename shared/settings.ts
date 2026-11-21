import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { parseBaseUrl } from "./base-url";
import { DEFAULT_INSTANCE_ID, DEFAULT_ORIGIN } from "./constants";

// Nothing secret goes into this document; the key lives in a private file.
export const connection = defineSettings({
  id: "connection",
  scope: "host",
  version: 1,
  schema: z.object({
    baseUrl: z
      .string()
      .trim()
      .default(DEFAULT_ORIGIN)
      .refine(
        (value) => parseBaseUrl(value).ok,
        "Enter an https:// address, or http://localhost for local tests",
      ),
    deviceName: z.string().trim().max(64).default(""),
    instanceId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .default(DEFAULT_INSTANCE_ID),
  }),
});

// A separate document keeps this switch apart from the connection form's draft and Save button.
export const mcp = defineSettings({
  id: "mcp",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
  }),
});
