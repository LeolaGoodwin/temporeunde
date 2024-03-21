import type {
  ContentCodec,
  EncodedContent,
  CodecRegistry,
} from "@xmtp/xmtp-js";
import { Ciphertext, ContentTypeId, encrypt, decrypt } from "@xmtp/xmtp-js";
import * as secp from "@noble/secp256k1";
import { content as proto } from "@xmtp/proto";
import { crypto } from "./encryption";

export const ContentTypeRemoteAttachment = new ContentTypeId({
  authorityId: "xmtp.org",
  typeId: "remoteStaticAttachment",
  versionMajor: 1,
  versionMinor: 0,
});

export type EncryptedEncodedContent = {
  digest: string;
  salt: Uint8Array;
  nonce: Uint8Array;
  secret: Uint8Array;
  payload: Uint8Array;
};

export type RemoteAttachment = {
  url: string;
  contentDigest: string;
  salt: Uint8Array;
  nonce: Uint8Array;
  secret: Uint8Array;
  scheme: string;
  contentLength: number;
  filename: string;
};

export class RemoteAttachmentCodec implements ContentCodec<RemoteAttachment> {
  static async load<T>(
    remoteAttachment: RemoteAttachment,
    codecRegistry: CodecRegistry,
  ): Promise<T> {
    const response = await fetch(remoteAttachment.url);
    const payload = new Uint8Array(await response.arrayBuffer());

    if (!payload) {
      throw new Error(
        `no payload for remote attachment at ${remoteAttachment.url}`,
      );
    }

    const digestBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", payload),
    );
    const digest = secp.utils.bytesToHex(digestBytes);

    if (digest !== remoteAttachment.contentDigest) {
      throw new Error("content digest does not match");
    }

    const ciphertext = new Ciphertext({
      aes256GcmHkdfSha256: {
        hkdfSalt: remoteAttachment.salt,
        gcmNonce: remoteAttachment.nonce,
        payload,
      },
    });

    const encodedContentData = await decrypt(
      ciphertext,
      remoteAttachment.secret,
    );
    const encodedContent = proto.EncodedContent.decode(encodedContentData);

    if (!encodedContent || !encodedContent.type) {
      throw new Error("no encoded content");
    }

    const contentType = encodedContent.type;
    if (!contentType) {
      throw new Error("no content type");
    }

    const codec = codecRegistry.codecFor(new ContentTypeId(contentType));

    if (!codec) {
      throw new Error(`no codec found for ${encodedContent.type?.typeId}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return codec.decode(encodedContent as EncodedContent, codecRegistry);
  }

  static async encodeEncrypted<T>(
    content: T,
    codec: ContentCodec<T>,
  ): Promise<EncryptedEncodedContent> {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const encodedContent = proto.EncodedContent.encode(
      codec.encode(content, {
        codecFor() {
          return undefined;
        },
      }),
    ).finish();
    const ciphertext = await encrypt(encodedContent, secret);
    const salt = ciphertext.aes256GcmHkdfSha256?.hkdfSalt;
    const nonce = ciphertext.aes256GcmHkdfSha256?.gcmNonce;
    const payload = ciphertext.aes256GcmHkdfSha256?.payload;

    if (!salt || !nonce || !payload) {
      throw new Error("missing encryption key");
    }

    const digestBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", payload),
    );
    const digest = secp.utils.bytesToHex(digestBytes);

    return {
      digest,
      secret,
      salt,
      nonce,
      payload,
    };
  }

  get contentType(): ContentTypeId {
    return ContentTypeRemoteAttachment;
  }

  encode(content: RemoteAttachment): EncodedContent {
    if (!content.url.startsWith("https")) {
      throw new Error("scheme must be https");
    }

    return {
      type: ContentTypeRemoteAttachment,
      parameters: {
        contentDigest: content.contentDigest,
        salt: secp.utils.bytesToHex(content.salt),
        nonce: secp.utils.bytesToHex(content.nonce),
        secret: secp.utils.bytesToHex(content.secret),
        scheme: content.scheme,
        contentLength: String(content.contentLength),
        filename: content.filename,
      },
      content: new TextEncoder().encode(content.url),
    };
  }

  decode(content: EncodedContent): RemoteAttachment {
    return {
      url: new TextDecoder().decode(content.content),
      contentDigest: content.parameters.contentDigest,
      salt: secp.utils.hexToBytes(content.parameters.salt),
      nonce: secp.utils.hexToBytes(content.parameters.nonce),
      secret: secp.utils.hexToBytes(content.parameters.secret),
      scheme: content.parameters.scheme,
      contentLength: parseInt(content.parameters.contentLength, 10),
      filename: content.parameters.filename,
    };
  }

  fallback(content: RemoteAttachment): string | undefined {
    return `Can’t display "${content.filename}". This app doesn’t support attachments.`;
  }
}
