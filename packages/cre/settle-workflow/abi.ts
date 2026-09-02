/**
 * The PitFactory functions this workflow calls.
 *
 * Kept as narrow literals rather than importing the full generated ABI: a
 * workflow compiles to WASM, and there is no reason to carry two hundred
 * fragments into it to make two static calls. `npm run check` in this package
 * asserts these fragments still match the compiled artifact.
 *
 * Both are the same shape of question — "what is outstanding?" — asked of a
 * chain that holds all the state, by a workflow that holds none.
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
  {
    type: "function",
    name: "missingWindows",
    stateMutability: "view",
    inputs: [
      { name: "underlying", type: "bytes32" },
      { name: "ends", type: "uint64[]" },
      { name: "strikeE8s", type: "uint256[]" },
      { name: "maxResults", type: "uint256" },
    ],
    outputs: [
      { name: "outEnds", type: "uint64[]" },
      { name: "outStrikes", type: "uint256[]" },
    ],
  },
] as const;
