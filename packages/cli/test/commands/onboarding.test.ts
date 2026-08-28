import { describe, expect, it } from "vitest";
import { runOnboarding } from "../../src/commands/onboarding.js";
import { LoginError } from "../../src/commands/login.js";
import { ApiError } from "../../src/core/api.js";

describe("explicit onboarding", () => {
  it("links the device without implicitly installing hooks or background services", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const code = await runOnboarding({
      loginDevice: async () => { calls.push("login"); },
      log: (message) => logs.push(message),
    });

    expect(code).toBe(0);
    expect(calls).toEqual(["login"]);
    expect(logs).toEqual([
      "Device linked. Run `burn repair` to explicitly enable hooks and automatic sync.",
    ]);
  });

  it("reports login failure without claiming that automation was enabled", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runOnboarding({
      loginDevice: async () => { throw new Error("device approval expired"); },
      log: (message) => logs.push(message),
      errorLog: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["Device login failed. Run `burn doctor` for diagnostics."]);
  });

  it("reports a content-free structured diagnostic for a registration API failure", async () => {
    const diagnostics: unknown[] = [];
    const errors: string[] = [];
    await runOnboarding({
      loginDevice: async () => {
        throw new LoginError(
          "device-registration",
          "Device approval completed, but registration failed. Run `burn login` again.",
          { cause: new ApiError(409, { error: "private server detail" }) },
        );
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      errorLog: (message) => errors.push(message),
    });

    expect(diagnostics).toEqual([{
      code: "device-registration",
      category: "api",
      apiStatus: 409,
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain("private server detail");
    expect(errors).toEqual([
      "Device approval completed, but registration failed. Run `burn login` again.",
    ]);
  });
});
