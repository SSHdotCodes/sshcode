import { describe, expect, it } from "vite-plus/test";

import { sessionBoxBaseIconId, SESSION_BOX_TOPICS, type SessionBoxTopic } from "./taxonomy.ts";
import { sessionBoxFace, sessionBoxFaceOf, sessionBoxFaces } from "./identity.ts";

const six = Object.fromEntries(SESSION_BOX_TOPICS.map((topic) => [topic, 6])) as Record<
  SessionBoxTopic,
  number
>;
const chat = (id: string, minute: number, topic: SessionBoxTopic = "training") => ({
  id,
  topic,
  createdAt: `2026-10-23T10:${String(minute).padStart(2, "0")}:00.000Z`,
});

describe("session box faces", () => {
  it("numbers a topic's paintings from its first", () => {
    expect(sessionBoxFace("training", 1, six)).toBe("topic-training");
    expect(sessionBoxFace("training", 3, six)).toBe("topic-training-3");
    expect(sessionBoxFace("training", 7, six)).toBe("topic-training");
    expect(sessionBoxBaseIconId("topic-training-3")).toBe("topic-training");
    expect(sessionBoxBaseIconId("activity-git")).toBe("activity-git");
  });

  it("gives the newest chats on a topic different paintings", () => {
    const chats = Array.from({ length: 14 }, (_, index) => chat(`t${index}`, index));
    const faces = sessionBoxFaces(chats, six);
    for (let start = 0; start + 6 <= chats.length; start++) {
      const window = chats.slice(start, start + 6).map((entry) => faces.get(entry.id));
      expect(new Set(window).size).toBe(6);
    }
  });

  it("keeps a chat's painting as newer chats arrive, and topics apart", () => {
    const before = sessionBoxFaces([chat("a", 1), chat("b", 2), chat("c", 3, "bug")], six);
    const after = sessionBoxFaces(
      [chat("d", 9), chat("a", 1), chat("c", 3, "bug"), chat("b", 2), chat("e", 10, "bug")],
      six,
    );
    for (const id of ["a", "b", "c"]) expect(after.get(id)).toBe(before.get(id));
    expect(after.get("c")?.startsWith("topic-bug")).toBe(true);
  });
});

describe("picked faces", () => {
  it("keeps the title step's pick unless an older chat on screen has it", () => {
    const faces = sessionBoxFaces(
      [
        { ...chat("old", 1), preferred: "topic-mobile-3" },
        { ...chat("new", 2), preferred: "topic-mobile-3" },
        { ...chat("other", 3), preferred: "topic-cleanup-2" },
        { ...chat("unknown", 4), preferred: "topic-nope-9" },
      ],
      six,
    );
    expect(faces.get("old")).toBe("topic-mobile-3");
    expect(faces.get("new")?.startsWith("topic-mobile")).toBe(true);
    expect(faces.get("new")).not.toBe("topic-mobile-3");
    expect(faces.get("other")).toBe("topic-cleanup-2");
    expect(faces.get("unknown")?.startsWith("topic-training")).toBe(true);
    expect(sessionBoxFaceOf("topic-mobile-7", six)).toBeNull();
    expect(sessionBoxFaceOf("topic-mobile", six)).toEqual({ topic: "mobile", variant: 1 });
  });
});
