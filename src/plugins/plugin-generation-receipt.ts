import { createHash, type Hash } from "node:crypto";
import { hashPluginSourceFile } from "./plugin-source-file.js";

type PluginSourceContent = { contentHash: string; sizeBytes: number };
type PluginGenerationReceipt = { signature: string; sourceDigest: string };
type PluginReceiptFile = {
  target: string;
  boundary: string;
  sizeBytes: number;
  native: boolean;
  /** Content proven by an adopted capture's stat identity; its prepared receipt must hit. */
  adopted?: boolean;
  onContent: (fact: PluginSourceContent) => void;
  content?: PluginSourceContent;
};

/** Reuse the initial raw-byte receipt only when its complete ordered inputs still match. */
export function createPluginGenerationReceipt(prepared?: PluginGenerationReceipt) {
  const events: Array<string | PluginReceiptFile> = [];
  let finished: PluginGenerationReceipt | undefined;
  const publishContent = (file: PluginReceiptFile, content: PluginSourceContent) => {
    if (content.sizeBytes !== file.sizeBytes) {
      throw new Error(
        "Plugin source changed while preparing its reload; retry after the edit finishes.",
      );
    }
    if (!file.content) {
      file.content = content;
      file.onContent(content);
    }
  };
  const readContent = (file: PluginReceiptFile, receipt?: Hash, expected = file.content) => {
    const content = hashPluginSourceFile(
      file.target,
      file.boundary,
      receipt,
      file.native ? file.content : undefined,
    );
    if (!file.native && expected && content.contentHash !== expected.contentHash) {
      throw new Error(
        "Plugin source changed while preparing its reload; retry after the edit finishes.",
      );
    }
    publishContent(file, content);
  };
  const inputSignature = () => {
    if (events.some((event) => typeof event !== "string" && !event.content)) {
      return undefined;
    }
    const signature = createHash("sha256");
    for (const event of events) {
      signature.update(
        JSON.stringify(
          typeof event === "string"
            ? ["marker", event]
            : ["file", event.sizeBytes, event.content!.contentHash],
        ),
      );
    }
    return signature.digest("hex");
  };
  return {
    marker(framed: string): void {
      if (!finished) {
        events.push(framed);
      }
    },
    file(params: Omit<PluginReceiptFile, "content"> & { prepared?: PluginSourceContent }): void {
      const { prepared: content, ...input } = params;
      const file: PluginReceiptFile = input;
      if (content) {
        if (finished && !file.native) {
          readContent(file, undefined, content);
        } else {
          publishContent(file, content);
        }
      } else if (!file.native || finished) {
        readContent(file);
      }
      if (!finished) {
        events.push(file);
      }
    },
    finish(): PluginGenerationReceipt {
      if (finished) {
        return finished;
      }
      const adopted = events.some((event) => typeof event !== "string" && event.adopted);
      if (adopted) {
        // Adopted bytes are proven by the prepared signature, so it must cover every file:
        // hash native bytes from their admitted custody before comparing it.
        for (const event of events) {
          if (typeof event !== "string" && event.native && !event.content) {
            readContent(event);
          }
        }
      }
      const signature = inputSignature();
      if (adopted && (signature === undefined || prepared?.signature !== signature)) {
        throw new Error("Plugin capture reuse changed its source receipt");
      }
      const receipt =
        signature !== undefined && prepared?.signature === signature
          ? undefined
          : createHash("sha256");
      for (const event of events) {
        if (typeof event === "string") {
          receipt?.update(event);
        } else if (receipt || !event.content || !(event.native || event.adopted)) {
          // Copied descriptors supply bytes, not pathname admission. Recheck ordinary
          // destinations even on a receipt hit; misses also replay native raw bytes.
          readContent(event, receipt);
        }
      }
      finished = {
        signature: signature ?? inputSignature()!,
        sourceDigest: receipt ? receipt.digest("hex") : prepared!.sourceDigest,
      };
      events.length = 0;
      return finished;
    },
  };
}
