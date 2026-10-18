import { open } from "node:fs/promises";
import { z } from "zod";
import { npdReceiptPlanSchema } from "@citygo/contracts";
import {
  inspectLivePaymentPreparation,
  operatorTaxRegimes,
  paymentSourcePolicies,
} from "./payment-live-readiness.js";

// Read-only CLI. It loads no .env, provider clients, DB or credentials. Only an
// explicitly supplied local operator input may be read; errors are redacted.
const inputSchema = z.strictObject({
  operatorTaxRegime: z.enum(operatorTaxRegimes).optional(),
  fiscalProfile: z.unknown().optional(),
  sourcePolicy: z.enum(paymentSourcePolicies).optional(),
  merchantReceiptsReportedEnabled: z.boolean().optional(),
  npdReceiptPlan: npdReceiptPlanSchema.optional(),
});
async function readLocalJson(file: string): Promise<unknown> {
  if (
    !file ||
    /^(?:[a-z][a-z0-9+.-]*:|\\\\|\/\/)/i.test(file.replace(/^[a-z]:[\\/]/i, ""))
  )
    throw new Error();
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384) throw new Error();
    const buffer = Buffer.alloc(16_385);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > 16_384) throw new Error();
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      ),
    ) as unknown;
  } finally {
    await handle.close();
  }
}

try {
  const args = process.argv.slice(2);
  if (
    args.length > 2 ||
    (args.length > 0 &&
      (!["--profile", "--input"].includes(args[0]!) || args.length !== 2))
  )
    throw new Error();
  const input = args.length
    ? args[0] === "--input"
      ? inputSchema.parse(await readLocalJson(args[1]!))
      : { fiscalProfile: await readLocalJson(args[1]!) }
    : {};
  const report = inspectLivePaymentPreparation(input);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 2; // Deliberately blocked, never an activation command.
} catch {
  console.error(
    "Не удалось проверить подготовку оплаты. Используйте локальный --input JSON или --profile JSON; исходные данные скрыты.",
  );
  process.exitCode = 1;
}
