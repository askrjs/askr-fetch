import type { Codec, InferValidator, Validator } from "./types";
const codec = <T>(
  kind: Codec<T>["kind"],
  mediaTypes: string[],
  validator?: Validator<T>,
): Codec<T> => Object.freeze({ kind, mediaTypes: Object.freeze(mediaTypes), validator });
/** Creates a JSON codec, matching `application/json` and `+json` suffixed media types. */
export function json<T = unknown>(): Codec<T>;
/** Creates a JSON codec that validates/parses the decoded value with the given schema. */
export function json<V extends Validator>(schema: V): Codec<InferValidator<V>>;
export function json(schema?: Validator): Codec {
  return codec("json", ["application/json", "+json"], schema);
}
/** Creates a codec for plain text bodies (`text/*`), decoded as a string. */
export const text = (): Codec<string> => codec("text", ["text/*"]);
/** Creates a codec for `application/x-www-form-urlencoded` bodies, decoded as `URLSearchParams`. */
export const urlEncoded = (): Codec<URLSearchParams> =>
  codec("urlEncoded", ["application/x-www-form-urlencoded"]);
/** Creates a codec for `multipart/form-data` bodies, decoded as `FormData`. */
export const multipart = (): Codec<FormData> => codec("multipart", ["multipart/form-data"]);
/** Creates a codec that decodes any response body as a `Blob`. */
export const blob = (): Codec<Blob> => codec("blob", ["*/*"]);
/** Creates a codec that decodes any response body as an `ArrayBuffer`. */
export const arrayBuffer = (): Codec<ArrayBuffer> => codec("arrayBuffer", ["*/*"]);
/** Creates a codec that exposes the raw response body as a `ReadableStream`, without buffering it. */
export const stream = (): Codec<ReadableStream<Uint8Array>> => codec("stream", ["*/*"]);
/** Creates a codec for bodies expected to be empty (e.g. 204 No Content), decoded as `undefined`. */
export const empty = (): Codec<undefined> => codec("empty", []);
/**
 * Creates a content-negotiated codec that selects among `variants` by the response's
 * media type, decoding with whichever variant matches.
 */
export const content = <T extends Record<string, Codec>>(
  variants: T,
): Codec<{ [K in keyof T]: T[K] extends Codec<infer V> ? V : never }[keyof T]> =>
  Object.freeze({
    kind: "content",
    mediaTypes: Object.freeze(Object.keys(variants).sort()),
    variants: Object.freeze({ ...variants }),
  });
