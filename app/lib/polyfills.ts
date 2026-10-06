// @bide/shared (and Anchor) use the Node `Buffer` global; provide it in the browser.
import { Buffer } from "buffer";

if (typeof globalThis !== "undefined" && !(globalThis as { Buffer?: unknown }).Buffer) {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}
