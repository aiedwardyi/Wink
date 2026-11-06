import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBotRoutes } from "./bot-routes.ts";
import { applyBrandLeadBot, BRAND_MARKER } from "./brand-lead-bot.ts";

type Bot = { id: string; name: string; chiefOfStaff?: boolean; avatarUrl?: string; avatarCrop?: string };

const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
let dataDir: string;
let bots: Bot[];
let broadcast: ReturnType<typeof vi.fn>;
let avatar: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "brand-lead-"));
  avatar = join(dataDir, "brand-lead.png");
  writeFileSync(avatar, Buffer.from("89504e470d0a1a0a", "hex"));
  bots = [{ id: "lead", name: "Wink", chiefOfStaff: true }, { id: "other", name: "Pokkey" }];
  broadcast = vi.fn();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function boot(leadBot: string = JSON.stringify({ name: "커맨더", avatarPath: avatar })) {
  const store = {
    patchBot: (id: string, patch: Partial<Bot>) => {
      const bot = bots.find((entry) => entry.id === id);
      return bot ? Object.assign(bot, patch) : null;
    },
  };
  const routes = createBotRoutes({
    store,
    wireBot: (bot: Bot) => ({ ...bot }),
    broadcast,
    storedAvatarExists: (url: string) => url === "/api/attachments/lead.png",
  } as unknown as Parameters<typeof createBotRoutes>[0]);
  return applyBrandLeadBot({
    dataDir,
    leadBot,
    chiefId: () => bots.find((bot) => bot.chiefOfStaff)?.id,
    saveAvatar: () => "/api/attachments/lead.png",
    applyProfile: routes.applyProfile,
  });
}

it("does nothing without a lead bot override", () => {
  expect(boot("")).toBe(false);
  expect(bots[0]).toEqual({ id: "lead", name: "Wink", chiefOfStaff: true });
  expect(existsSync(join(dataDir, BRAND_MARKER))).toBe(false);
});

it("renames the lead bot once through the profile path", () => {
  expect(boot()).toBe(true);
  expect(bots[0]).toMatchObject({ name: "커맨더", avatarUrl: "/api/attachments/lead.png", avatarCrop: "rounded" });
  expect(bots[1].name).toBe("Pokkey");
  expect(broadcast).toHaveBeenCalledWith({ kind: "bot", bot: expect.objectContaining({ id: "lead", name: "커맨더" }) });
  expect(JSON.parse(readFileSync(join(dataDir, BRAND_MARKER), "utf8")).leadBotAppliedAt).toEqual(expect.any(String));
  expect(boot()).toBe(false);
  expect(broadcast).toHaveBeenCalledTimes(1);
});

it("keeps a later rename by hand", () => {
  boot();
  bots[0].name = "아빠 비서";
  expect(boot()).toBe(false);
  expect(bots[0].name).toBe("아빠 비서");
});

it("waits for a lead bot to exist", () => {
  bots[0].chiefOfStaff = false;
  expect(boot()).toBe(false);
  expect(existsSync(join(dataDir, BRAND_MARKER))).toBe(false);
  bots[0].chiefOfStaff = true;
  expect(boot()).toBe(true);
});

it("leaves no marker when the profile refuses the change", () => {
  expect(boot(JSON.stringify({ name: "x".repeat(101), avatarPath: avatar }))).toBe(false);
  expect(boot(JSON.stringify({ name: "커맨더", avatarPath: join(dataDir, "gone.png") }))).toBe(false);
  expect(bots[0].name).toBe("Wink");
  expect(existsSync(join(dataDir, BRAND_MARKER))).toBe(false);
});

it("is wired into boot from the desktop's env", () => {
  expect(index).toContain("leadBot: process.env.OMB_BRAND_LEAD_BOT,");
  expect(index).toContain("applyProfile: botRoutes.applyProfile,");
});
