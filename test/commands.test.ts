import { describe, expect, it } from "vitest";
import {
  isReservedGroupName,
  normalizeGroupName,
  parseBellCommand,
  removeLeadingAppMention,
} from "../src/slack/commands";

describe("Slack mention parsing", () => {
  it("removes only the leading app mention", () => {
    expect(removeLeadingAppMention("  <@U123ABC>  10기 운영진 ")).toBe("10기 운영진");
    expect(removeLeadingAppMention("10기 <@U456DEF> 운영진")).toBe(
      "10기 <@U456DEF> 운영진",
    );
  });

  it("normalizes whitespace without splitting the group name", () => {
    expect(normalizeGroupName("  AUSG   운영진\n TF ")).toBe("AUSG 운영진 TF");
    expect(parseBellCommand("<@U123ABC> AUSG   운영진 TF")).toEqual({
      type: "mention_group",
      groupName: "AUSG 운영진 TF",
    });
  });

  it("normalizes equivalent Unicode names to NFC", () => {
    expect(normalizeGroupName("Cafe\u0301 운영진")).toBe("Café 운영진");
  });

  it("decodes Slack's escaped text entities before looking up a group", () => {
    expect(parseBellCommand("<@U123ABC> AUSG &amp; AWS &lt;TF&gt;")).toEqual({
      type: "mention_group",
      groupName: "AUSG & AWS <TF>",
    });
  });
});

describe("Bell commands", () => {
  it.each(["목록", "list", "LIST"])("parses the full group list command: %s", (value) => {
    expect(parseBellCommand(`<@U123ABC> ${value}`)).toEqual({ type: "list_groups" });
  });

  it.each(["help", "HELP", "도움말", ""])("parses the help command: %s", (value) => {
    expect(parseBellCommand(`<@U123ABC> ${value}`)).toEqual({ type: "help" });
  });

  it("parses a Korean member list suffix", () => {
    expect(parseBellCommand("<@U123ABC> 10기 운영진 목록")).toEqual({
      type: "list_members",
      groupName: "10기 운영진",
    });
  });

  it("supports the English member list suffix", () => {
    expect(parseBellCommand("<@U123ABC> 행사 TF list")).toEqual({
      type: "list_members",
      groupName: "행사 TF",
    });
  });

  it.each(["목록", "list", "LIST", "도움말", "help", "HELP", "행사 TF 목록", "행사 TF list"])(
    "marks names that collide with a command as reserved: %s",
    (value) => {
      expect(isReservedGroupName(value)).toBe(true);
    },
  );

  it.each(["목록 TF", "help 팀", "AUSG list 팀"])(
    "allows names that do not parse as a command: %s",
    (value) => {
      expect(isReservedGroupName(value)).toBe(false);
    },
  );
});
