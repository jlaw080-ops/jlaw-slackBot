/**
 * #작업일지·#할일 채널에 슬래시 명령 없이 타이핑한 평문 메시지를 주워 오는 필터.
 * 실제 요청이 오면 무엇을 재료로 잡고 무엇을 버려야 하는지가 핵심이라, 네트워크 없이
 * 순수 판정 함수만 검증합니다.
 */
import { describe, expect, it } from "vitest";
import { isPlainNewMessage, sourceLabel, type SlackMessageEvent } from "../../api/slack/events.js";
import { config } from "../lib/config.js";

const base: SlackMessageEvent = {
  type: "message",
  channel: config.slack.channelWorklog,
  ts: "1700000000.000100",
  text: "오늘 회의 정리했음",
};

describe("sourceLabel", () => {
  it("작업일지·할일 채널만 알아본다", () => {
    expect(sourceLabel(config.slack.channelWorklog)).toBe("작업일지 채널");
    expect(sourceLabel(config.slack.channelTodo)).toBe("할일 채널");
    expect(sourceLabel("C_다른채널")).toBeNull();
  });
});

describe("isPlainNewMessage", () => {
  it("사람이 새로 쓴 평문 메시지는 재료로 잡는다", () => {
    expect(isPlainNewMessage(base)).toBe(true);
  });
  it("우리 봇을 포함해 봇이 올린 메시지는 버린다", () => {
    expect(isPlainNewMessage({ ...base, bot_id: "B123" })).toBe(false);
  });
  it("메시지 수정·삭제·채널 입장 같은 subtype 은 버린다", () => {
    expect(isPlainNewMessage({ ...base, subtype: "message_changed" })).toBe(false);
    expect(isPlainNewMessage({ ...base, subtype: "bot_message" })).toBe(false);
    expect(isPlainNewMessage({ ...base, subtype: "channel_join" })).toBe(false);
  });
  it("스레드 답글은 버리고, 스레드의 첫 메시지(자기 자신)는 잡는다", () => {
    expect(isPlainNewMessage({ ...base, thread_ts: "1699999999.000000" })).toBe(false);
    expect(isPlainNewMessage({ ...base, thread_ts: base.ts })).toBe(true);
  });
  it("본문이 비어 있으면 버린다", () => {
    expect(isPlainNewMessage({ ...base, text: "" })).toBe(false);
    expect(isPlainNewMessage({ ...base, text: "   " })).toBe(false);
    expect(isPlainNewMessage({ ...base, text: undefined })).toBe(false);
  });
  it("message 타입이 아니면 버린다 (예: reaction_added)", () => {
    expect(isPlainNewMessage({ ...base, type: "reaction_added" })).toBe(false);
  });
});
