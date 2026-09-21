export interface UsageCost {
  inputTokens: number;
  outputTokens: number;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  estimatedCost: string;
}
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputPrice: string,
  outputPrice: string,
): UsageCost {
  const scale = 1_000_000n;
  const micros =
    (BigInt(inputTokens) * decimalMicros(inputPrice) +
      BigInt(outputTokens) * decimalMicros(outputPrice)) /
    scale;
  return {
    inputTokens,
    outputTokens,
    inputPricePerMillion: inputPrice,
    outputPricePerMillion: outputPrice,
    estimatedCost: `${micros / scale}.${(micros % scale).toString().padStart(6, "0")}`,
  };
}
const decimalMicros = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6))
  );
};
