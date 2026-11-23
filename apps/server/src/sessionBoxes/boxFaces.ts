/**
 * The icon picture each chat's title step picked: the session title model reads the
 * pictures alongside the chat and names the one that fits it best, in the same reply as
 * the title. Shell rows carry the pick as `boxFace`; chats titled before this, or whose
 * reply named no picture, have none and clients pick from the title instead. Saved in
 * box-faces.json in the state dir.
 */
import type { ThreadTitlePictures } from "@t3tools/provider-core/server/textGeneration";
import {
  SESSION_BOX_FACE_COUNTS,
  SESSION_BOX_FACE_PICTURES,
  SESSION_BOX_TOPIC_INFO,
  SESSION_BOX_TOPICS,
  sessionBoxFace,
  type SessionBoxIconId,
  type SessionBoxTopic,
} from "@t3tools/shared/sessionBoxes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { announceBoxChange } from "./boxNamerCache.ts";

const FACES_FILE = "box-faces.json";

/** The pictures offered to the title step: every topic's paintings, ids like `mobile-3`. */
export function titlePictures(): ThreadTitlePictures {
  return SESSION_BOX_TOPICS.map((topic) => ({
    covers: SESSION_BOX_TOPIC_INFO[topic].covers,
    pictures: SESSION_BOX_FACE_PICTURES[topic]
      .slice(0, SESSION_BOX_FACE_COUNTS[topic])
      .map((picture, index) => ({ id: index === 0 ? topic : `${topic}-${index + 1}`, picture })),
  }));
}

/** The painting a title reply named (`mobile-3`, or `topic-mobile-3`), if it is one. */
export function faceFromPick(pick: string): SessionBoxIconId | null {
  const match = /^(?:topic-)?([a-z]+)(?:-(\d+))?$/u.exec(pick.trim().toLowerCase());
  if (match === null) return null;
  const topic = match[1] as SessionBoxTopic;
  if (!SESSION_BOX_TOPICS.includes(topic)) return null;
  const variant = match[2] === undefined ? 1 : Number(match[2]);
  if (variant < 1 || variant > SESSION_BOX_FACE_COUNTS[topic]) return null;
  return sessionBoxFace(topic, variant);
}

export class BoxFaces extends Context.Service<BoxFaces, ReturnType<typeof make>["store"]>()(
  "t3/sessionBoxes/boxFaces",
) {}

export function make() {
  const faces = new Map<string, SessionBoxIconId>();
  let onChange: (() => void) | null = null;

  const boxFaces = {
    get(threadId: string): SessionBoxIconId | null {
      return faces.get(threadId) ?? null;
    },
    set(threadId: string, face: SessionBoxIconId) {
      if (faces.get(threadId) === face) return;
      faces.set(threadId, face);
      onChange?.();
      announceBoxChange(threadId);
    },
    entries(): ReadonlyArray<readonly [string, SessionBoxIconId]> {
      return [...faces];
    },
  };

  const FacesFile = Schema.Struct({
    version: Schema.Literal(1),
    faces: Schema.Record(Schema.String, Schema.String),
  });
  const decodeFaces = Schema.decodeUnknownEffect(Schema.fromJsonString(FacesFile));
  const encodeFaces = Schema.encodeEffect(Schema.fromJsonString(FacesFile));

  /** Loads the saved picks at startup and saves them as they change. */
  const load = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(config.stateDir, FACES_FILE);
    const saved = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeFaces),
      Effect.map((contents) => Object.entries(contents.faces)),
      Effect.orElseSucceed(() => [] as Array<[string, string]>),
    );
    for (const [threadId, face] of saved) {
      const known = faceFromPick(face);
      if (known !== null) faces.set(threadId, known);
    }
    const save = Effect.gen(function* () {
      const encoded = yield* encodeFaces({ version: 1, faces: Object.fromEntries(faces) });
      yield* fs.writeFileString(`${file}.tmp`, encoded, { mode: 0o600 });
      yield* fs.rename(`${file}.tmp`, file);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not save chat icons.", { cause })),
    );
    const saves = yield* Queue.sliding<void>(1);
    // Saves coalesce; `dirty` lets shutdown write the last change instead of dropping it.
    let dirty = false;
    const flush = Effect.suspend(() => {
      if (!dirty) return Effect.void;
      dirty = false;
      return save;
    }).pipe(Effect.uninterruptible);
    onChange = () => {
      dirty = true;
      Queue.offerUnsafe(saves, undefined);
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => (onChange = null)).pipe(Effect.andThen(flush)),
    );
    yield* Queue.take(saves).pipe(Effect.andThen(flush), Effect.forever, Effect.forkScoped);
  });

  return { store: { ...boxFaces }, load };
}

export const layer = Layer.effect(
  BoxFaces,
  Effect.gen(function* () {
    const instance = make();
    yield* instance.load;
    return instance.store;
  }),
);
