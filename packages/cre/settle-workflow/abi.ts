/**
 * The one PitFactory function this workflow calls.
 *
 * Kept as a narrow literal rather than importing the full generated ABI: a
 * workflow compiles to WASM, and there is no reason to carry two hundred
 * fragments into it to make one static call. `npm run check` in this package
 * asserts this fragment still matches the compiled artifact.
 */
export const PIT_FACTORY_ABI = [
  {
    type: "function",
    name: "pendingSettlement",
    stateMutability: "view",
    inputs: [
      { name: "lookback", type: "uint256" },
      { name: "maxResults", type: "uint256" },
    ],
    outputs: [{ name: "ids", type: "uint256[]" }],
  },
] as const;
