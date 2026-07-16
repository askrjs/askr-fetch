import type { Codec, Validator } from "./types";
const codec = <T>(kind: Codec<T>["kind"], mediaTypes: string[], validator?: Validator<T>): Codec<T> => Object.freeze({ kind, mediaTypes: Object.freeze(mediaTypes), validator });
export function json<T = unknown>(): Codec<T>;
export function json<V extends Validator>(schema: V): Codec<V extends Validator<infer T> ? T : never>;
export function json(schema?: Validator): Codec { return codec("json", ["application/json", "+json"], schema); }
export const text = (): Codec<string> => codec("text", ["text/*"]);
export const urlEncoded = (): Codec<URLSearchParams> => codec("urlEncoded", ["application/x-www-form-urlencoded"]);
export const multipart = (): Codec<FormData> => codec("multipart", ["multipart/form-data"]);
export const blob = (): Codec<Blob> => codec("blob", ["*/*"]);
export const arrayBuffer = (): Codec<ArrayBuffer> => codec("arrayBuffer", ["*/*"]);
export const stream = (): Codec<ReadableStream<Uint8Array>> => codec("stream", ["*/*"]);
export const empty = (): Codec<undefined> => codec("empty", []);
export const content = <T extends Record<string, Codec>>(variants: T): Codec<{ [K in keyof T]: T[K] extends Codec<infer V> ? V : never }[keyof T]> => Object.freeze({ kind: "content", mediaTypes: Object.freeze(Object.keys(variants).sort()), variants: Object.freeze({ ...variants }) });
