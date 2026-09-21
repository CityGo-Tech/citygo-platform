import https from "node:https";
import { getCACertificates } from "node:tls";
import { Readable } from "node:stream";
import { readFileSync, statSync } from "node:fs";
import { X509Certificate } from "node:crypto";

export const gigaAuthUrl = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
export const gigaChatUrl = "https://api.giga.chat/v1/chat/completions";
export type GigaPost = (
  url: string,
  init: {
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export function createGigaPost(caBundleFile?: string): GigaPost {
  let ca: string[] | undefined;
  if (caBundleFile) {
    try {
      const stat = statSync(caBundleFile);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error();
      const pem = readFileSync(caBundleFile, "utf8");
      const certificates = pem.match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      );
      if (
        !certificates?.length ||
        pem
          .replace(
            /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
            "",
          )
          .trim()
      )
        throw new Error();
      for (const certificate of certificates) {
        if (!new X509Certificate(certificate).ca) throw new Error();
      }
      // Additional trust applies only to this transport, never the whole process.
      ca = [...getCACertificates("default"), ...certificates];
    } catch {
      throw new Error(
        "GIGACHAT_CA_BUNDLE_FILE must be a readable PEM CA certificate bundle",
      );
    }
  }
  return async (url, init) => {
    if (url !== gigaAuthUrl && url !== gigaChatUrl)
      throw new Error("Unexpected GigaChat endpoint");
    init.signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      // No redirects, proxy/base-URL overrides or unverified TLS. agent:false
      // keeps this transport's trust settings isolated from global agents.
      const request = https.request(
        url,
        {
          method: "POST",
          // api.giga.chat may reject requests without User-Agent (HTTP 403).
          // This fixed identifier contains no account or host information.
          headers: { ...init.headers, "User-Agent": "CityGo-GigaChat/1.0" },
          signal: init.signal,
          agent: false,
          rejectUnauthorized: true,
          ...(ca ? { ca } : {}),
        },
        (incoming) => {
          const status = incoming.statusCode ?? 500;
          if (status !== 200) {
            incoming.destroy();
            resolve(new Response(null, { status }));
            return;
          }
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2)
            headers.append(
              incoming.rawHeaders[index]!,
              incoming.rawHeaders[index + 1]!,
            );
          resolve(
            new Response(
              Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
              { status, headers },
            ),
          );
        },
      );
      request.on("error", () =>
        reject(new Error("GigaChat HTTPS request failed")),
      );
      request.end(init.body);
    });
  };
}
