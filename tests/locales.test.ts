import { describe, expect, it } from "vitest";
import en from "../client/locales/en.json";
import vi from "../client/locales/vi.json";

type Resource = { [key: string]: string | Resource };

function flatten(resource: Resource, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(resource)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") result.set(path, value);
    else for (const [nested, text] of flatten(value, path)) result.set(nested, text);
  }
  return result;
}

const placeholders = (text: string) =>
  [...text.matchAll(/{{\s*([^},\s]+)\s*}}/g)].map((match) => match[1]).sort();

describe("locale files", () => {
  const english = flatten(en);
  const vietnamese = flatten(vi);

  it("have the same keys", () => {
    expect([...vietnamese.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it("have the same placeholders for every key", () => {
    for (const [key, text] of english) {
      expect(placeholders(vietnamese.get(key) ?? ""), key).toEqual(placeholders(text));
    }
  });

  it("have no empty strings", () => {
    for (const [key, text] of [...english, ...vietnamese]) {
      expect(text.trim(), key).not.toBe("");
    }
  });

  it("cover every reason and error code the daemon can report", async () => {
    const { SignedOutReason, ErrorCode } = await import("../shared/status");
    for (const reason of SignedOutReason.options) expect(english.has(`reasons.${reason}`)).toBe(true);
    for (const code of ErrorCode.options) expect(english.has(`errors.${code}`)).toBe(true);
  });

  it("cover every harness, state, error and removal result the account screen can show", async () => {
    const { HarnessId, HarnessState, HarnessErrorCode, SetupError, RemovalResult, SetupStep, HookFailureReason } =
      await import("../shared/harness");
    for (const id of HarnessId.options) expect(english.has(`harness.${id}`), id).toBe(true);
    for (const state of HarnessState.options) expect(english.has(`harnessState.${state}`), state).toBe(true);
    for (const code of HarnessErrorCode.options) expect(english.has(`harnessErrors.${code}`), code).toBe(true);
    for (const code of HarnessErrorCode.options) expect(english.has(`harnessFixes.${code}`), code).toBe(true);
    for (const step of SetupStep.options) expect(english.has(`setupSteps.${step}`), step).toBe(true);
    for (const reason of HookFailureReason.options) {
      expect(english.has(`hookReasons.${reason}`), reason).toBe(true);
      expect(english.has(`hookFixes.${reason}`), reason).toBe(true);
    }
    for (const code of SetupError.options) expect(english.has(`setupErrors.${code}`), code).toBe(true);
    for (const result of RemovalResult.options) expect(english.has(`removalResults.${result}`), result).toBe(true);
  });

  it("cover every inventory source and error the local skills screen can show", async () => {
    const { InventorySource, InventoryErrorCode } = await import("../shared/inventory");
    for (const source of InventorySource.options) expect(english.has(`inventorySources.${source}`), source).toBe(true);
    for (const code of InventoryErrorCode.options) expect(english.has(`inventoryErrors.${code}`), code).toBe(true);
  });

  it("are accepted by the plugin translation runtime", async () => {
    // The client entry may need react-native; skip only this assertion when it cannot load in Node.
    let define: typeof import("@getpaseo/plugin/client").defineTranslations;
    try {
      ({ defineTranslations: define } = await import("@getpaseo/plugin/client"));
    } catch {
      return;
    }
    expect(() => define({ resources: { en, vi } })).not.toThrow();
  });
});
