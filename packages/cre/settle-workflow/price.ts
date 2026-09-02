/**
 * Price parsing, kept out of main.ts so it can be tested without booting a
 * workflow runtime (main.ts runs itself on import, as the SDK requires).
 */

/**
 * "65123.45" -> 6512345000000n.
 *
 * A decimal string in, a scaled integer out, and no float anywhere in between.
 * This matters more here than it looks: median consensus runs over these values,
 * and a window can settle on the last cent.
 */
export function parseE8(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Not a decimal price: "${amount}"`);

  const [whole = "0", fraction = ""] = trimmed.split(".");
  const padded = (fraction + "00000000").slice(0, 8);
  return BigInt(whole) * 100_000_000n + BigInt(padded);
}

export function formatE8(value: bigint): string {
  const whole = value / 100_000_000n;
  const cents = (value % 100_000_000n).toString().padStart(8, "0").slice(0, 2);
  return `$${whole.toLocaleString("en-US")}.${cents}`;
}
