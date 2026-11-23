import { describe, expect, it } from "vitest";
import * as rpc from "../shared/rpc";

// The daemon rejects a method name outside this pattern when the plugin loads.
const DAEMON_RPC_NAME = /^[a-z][a-z0-9._-]*$/;

describe("plugin RPC names", () => {
  it("loads every contract and names each method the way the daemon accepts", () => {
    const names = Object.values(rpc).map((contract) => contract.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(DAEMON_RPC_NAME);
  });
});
