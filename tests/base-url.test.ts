import { describe, expect, it } from "vitest";
import { parseBaseUrl } from "../shared/base-url";

describe("parseBaseUrl", () => {
  it("accepts https origins and drops a trailing slash", () => {
    expect(parseBaseUrl("https://am.example.net")).toEqual({ ok: true, origin: "https://am.example.net" });
    expect(parseBaseUrl("  https://am.example.net:8443/ ")).toEqual({
      ok: true,
      origin: "https://am.example.net:8443",
    });
  });

  it("accepts http only on loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(parseBaseUrl(`http://${host}:18125`).ok).toBe(true);
    }
    expect(parseBaseUrl("http://am.example.net")).toEqual({ ok: false, reason: "insecure" });
    expect(parseBaseUrl("http://10.0.0.5")).toEqual({ ok: false, reason: "insecure" });
  });

  it("refuses paths, queries, hashes and credentials", () => {
    for (const bad of [
      "https://am.example.net/panel",
      "https://am.example.net/?a=1",
      "https://am.example.net/#x",
      "https://user:pw@am.example.net",
    ]) {
      expect(parseBaseUrl(bad)).toEqual({ ok: false, reason: "not_origin" });
    }
  });

  it("refuses garbage and other schemes", () => {
    expect(parseBaseUrl("")).toEqual({ ok: false, reason: "invalid" });
    expect(parseBaseUrl("not a url")).toEqual({ ok: false, reason: "invalid" });
    expect(parseBaseUrl("ftp://am.example.net")).toEqual({ ok: false, reason: "invalid" });
  });
});
