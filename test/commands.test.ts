import { describe, expect, it } from "vitest";
import {
  buildGroupNameCandidates,
  isMemberListRequest,
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
      type: "group_request",
      groupText: "AUSG 운영진 TF",
      allowPrefixMatch: true,
    });
  });

  it("normalizes equivalent Unicode names to NFC", () => {
    expect(normalizeGroupName("Cafe\u0301 운영진")).toBe("Café 운영진");
  });

  it("decodes Slack's escaped text entities before looking up a group", () => {
    expect(parseBellCommand("<@U123ABC> AUSG &amp; AWS &lt;TF&gt;")).toEqual({
      type: "group_request",
      groupText: "AUSG & AWS <TF>",
      allowPrefixMatch: true,
    });
  });

  it("uses only the first line as an exact group name", () => {
    expect(parseBellCommand("<@U123ABC> 행사팀\n오늘 3시에 모여주세요")).toEqual({
      type: "group_request",
      groupText: "행사팀",
      allowPrefixMatch: false,
    });
  });

  it("uses the text before a pipe separator as an exact group name", () => {
    expect(parseBellCommand("<@U123ABC> 행사팀 | 오늘 3시에 모여주세요")).toEqual({
      type: "group_request",
      groupText: "행사팀",
      allowPrefixMatch: false,
    });
  });

  it("builds longest-first candidates only at whitespace boundaries", () => {
    expect(buildGroupNameCandidates("AUSG 운영진 오늘 회의합니다", true)).toEqual([
      "AUSG 운영진 오늘 회의합니다",
      "AUSG 운영진 오늘",
      "AUSG 운영진",
      "AUSG",
    ]);
    expect(buildGroupNameCandidates("행사팀 공지", false)).toEqual(["행사팀 공지"]);
  });
});

describe("Bell commands", () => {
  it.each(["목록", "list", "LIST"])("parses the full group list command: %s", (value) => {
    expect(parseBellCommand(`<@U123ABC> ${value}`)).toEqual({ type: "list_groups" });
  });

  it.each(["help", "HELP", "도움말", ""])("parses the help command: %s", (value) => {
    expect(parseBellCommand(`<@U123ABC> ${value}`)).toEqual({ type: "help" });
  });

  it("defers a Korean member list request until its group is resolved", () => {
    expect(parseBellCommand("<@U123ABC> 10기 운영진 목록")).toEqual({
      type: "group_request",
      groupText: "10기 운영진 목록",
      allowPrefixMatch: true,
    });
    expect(isMemberListRequest("10기 운영진 목록", "10기 운영진")).toBe(true);
  });

  it("supports the English member list suffix after resolving the group", () => {
    expect(parseBellCommand("<@U123ABC> 행사 TF list")).toEqual({
      type: "group_request",
      groupText: "행사 TF list",
      allowPrefixMatch: true,
    });
    expect(isMemberListRequest("행사 TF LIST", "행사 TF")).toBe(true);
    expect(isMemberListRequest("행사 TF 오늘 할 일 목록", "행사 TF")).toBe(false);
  });

  it.each([
    "목록",
    "list",
    "LIST",
    "도움말",
    "help",
    "HELP",
    "행사 TF 목록",
    "행사 TF list",
    "행사팀 | 공지",
  ])(
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
