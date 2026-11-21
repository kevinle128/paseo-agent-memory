import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import vi from "./locales/vi.json";

// English is the default. The app has no `vi` language yet, so the Vietnamese file renders only
// once the app adds it.
export const messages = defineTranslations({ resources: { en, vi } });
