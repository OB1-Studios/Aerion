import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import { appSettings } from "../src/provision";

describe("the app's settings for Coolify", () => {
  it("uses the domain when there is one, and otherwise a name for the VM's IP", () => {
    expect(appSettings(readConfig({ DOMAIN: "example.com" }), "203.0.113.7", {}, undefined).BETTER_AUTH_URL).toBe("https://app.example.com");
    expect(appSettings(readConfig({}), "203.0.113.7", {}, undefined).BETTER_AUTH_URL).toBe("https://203-0-113-7.sslip.io");
  });

  it("generates each secret once and keeps it on a re-run", () => {
    const first = appSettings(readConfig({}), "203.0.113.7", {}, "chosen-password");
    expect(first.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(first.APP_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(first.APP_ENCRYPTION_KEY).not.toBe(first.BETTER_AUTH_SECRET);
    expect(first.DEMO_PASSWORD).toBe("chosen-password");

    const again = appSettings(readConfig({}), "203.0.113.7", first, "changed-in-env");
    expect(again).toEqual(first);
  });

  it("makes up a demo password when none was chosen", () => {
    expect(appSettings(readConfig({}), "203.0.113.7", {}, undefined).DEMO_PASSWORD.length).toBeGreaterThanOrEqual(20);
  });
});
