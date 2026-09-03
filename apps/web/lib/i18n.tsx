"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";

/**
 * The copy, in one place.
 *
 * English only. The indirection stays because it keeps every string the product
 * says in one file, where the wording can be argued about without going through
 * nine components.
 *
 * Two rules for the copy in here. An action names what happens when it is used
 * and keeps that name through the whole flow: the button that says "Buy YES at
 * 62¢" produces "Bought 40 YES at 62¢". And an empty state is an instruction,
 * not a mood — "nobody is quoting this one yet" is followed by what to do about
 * it.
 */

export type Locale = "en";

const dictionary = {
  en: {
    "app.tagline": "The five-minute option chain, on Kuru's onchain book.",

    "wallet.connect": "Connect wallet",
    "wallet.connecting": "Connecting…",
    "wallet.none": "No wallet found",
    "wallet.switch": "Switch to {chain}",

    "board.empty": "No cells in this range.",
    "board.emptyHint":
      "Nothing is opening the next columns. Run {command} and the board stays open.",
    "board.realised": "Last {minutes} min",
    "board.now": "Now",
    "board.strike": "Strike",
    "board.strikeAxis": "BTC above",
    "board.closed": "closed",
    "board.settling": "settling",
    "board.yes": "YES",
    "board.no": "NO",
    "board.void": "VOID",
    "board.spot": "Price now",
    "board.legendPay": "Number is what it pays",
    "board.legendDepth": "Colour is side and size on the book",
    "board.legendHollow": "Hollow means nobody is quoting",
    "board.legendTrace": "BTC",
    "board.legendHint": "Click a cell to trade it",
    "board.noDepth": "no book",
    "board.crossed": "bad book",
    "board.cardDepth": "On the book",
    "board.cardMakers": "Quoting",
    "board.cardSpread": "Spread",
    "board.cardLeft": "{clock} left",
    "board.cardClosed": "closed",
    "board.titleWidth": "{width} wide",
    "board.titleMakers": "{makers} quoting",

    "cell.select": "Pick a cell.",
    "cell.selectHint": "You get the live book, the tape and who is quoting — and you can quote too.",
    "cell.close": "Close",
    "cell.more": "Book · tape · flow · notes",
    "cell.less": "Just the ticket",
    "cell.claim": "BTC above {strike}",
    "cell.closes": "closes {time}",
    "cell.expired": "closed",
    "cell.book": "Book",
    "cell.tape": "Tape",
    "cell.flow": "Flow",
    "cell.notes": "Notes",
    "cell.makers": "On the book",
    "cell.noMakers": "Nobody quoting yet.",
    "cell.noBook": "The book is empty.",
    "cell.noBookHint": "Post a price on the Make tab and you are the first quote on this cell.",
    "cell.price": "Price",
    "cell.size": "Size",
    "cell.orders": "Orders",
    "cell.width": "Width",
    "cell.usePrice": "Use this price",
    "cell.traded": "traded",
    "cell.cvd": "CVD",
    "cell.noFills": "No trades yet.",
    "cell.onKuru": "Book on Kuru · {market}",
    "cell.arb": "buy both legs and lock {edge}",
    "cell.overround": "{over} of spread across both legs",
    "cell.outcome.yes": "Settled YES",
    "cell.outcome.no": "Settled NO",
    "cell.outcome.void": "Voided · each leg pays 50¢",

    "ticket.take": "Take",
    "ticket.make": "Make",
    "ticket.yes": "YES",
    "ticket.no": "NO",
    "ticket.amount": "Amount in dollars",
    "ticket.toWin": "To win",
    "ticket.takeDetail": "{contracts} contracts at {price} · costs ${spend} · {multiple}",
    "ticket.noOffer": "Nobody is offering this leg",
    "ticket.tooSmall": "Raise the amount — it does not cover one whole contract.",
    "ticket.buyAction": "Buy {side} at {price}",
    "ticket.price": "Price",
    "ticket.size": "Contracts",
    "ticket.makeDetail": "Locks ${locks} {symbol} and pays ${pays} if the leg wins.",
    "ticket.makeInvalid": "Price between 1¢ and 99¢, size above zero.",
    "ticket.postBid": "Post bid",
    "ticket.postAsk": "Post offer",
    "ticket.needInventory": "Selling a leg needs the token. Lock collateral to mint YES + NO.",
    "ticket.mint": "Lock {size} {symbol} and mint YES + NO",
    "ticket.myOrders": "My orders",
    "ticket.cancelAll": "Cancel all",
    "ticket.noOrders": "No open orders on this cell.",
    "ticket.bid": "bid",
    "ticket.ask": "offer",
    "ticket.needWallet": "Connect a wallet to trade.",
    "ticket.redeem": "Redeem",
    "ticket.redeemBlurb": "The winning leg pays $1 a contract.",
    "ticket.sending": "Sending…",
    "ticket.posting": "Posting…",
    "ticket.cancelling": "Cancelling…",
    "ticket.minting": "Minting…",
    "ticket.redeeming": "Redeeming…",
    "ticket.bought": "Bought {contracts} {side} at {price}.",
    "ticket.posted": "Posted {size} {side} at {price}.",
    "ticket.cancelled": "Orders cancelled.",
    "ticket.minted": "Minted {size} YES + {size} NO.",
    "ticket.redeemed": "Redeemed.",

    "notes.blurb":
      "Encrypted with your passkey. The server only ever holds ciphertext — the same passkey on a second device opens the same notes.",
    "notes.enroll": "Create passkey",
    "notes.unlock": "Unlock with passkey",
    "notes.unlocking": "Waiting for the passkey…",
    "notes.placeholder": "Why are you in this cell? Only you can read this.",
    "notes.save": "Save",
    "notes.saving": "Saving…",
    "notes.saved": "Saved",
    "notes.lock": "Lock",
    "notes.unsupported": "This browser does not expose the WebAuthn PRF extension.",
    "notes.crossDevice": "Vault {vault} · opened with your passkey",

    "risk.title": "This is a prediction market. Read this before trading.",
    "risk.body":
      "Each contract pays $1 if its leg wins and nothing if it loses. You can lose everything you put in. Settlement uses a public reference price at the close of the window. On testnet the tokens are worth nothing.",
    "risk.accept": "Understood",
    "risk.more": "Risk",

    "status.indexer": "Indexer",
    "status.stale": "{seconds}s behind",
    "status.down": "down",
    "status.live": "live",
    "status.loading": "Loading the board",
    "status.notConfigured":
      "Set NEXT_PUBLIC_PIT_FACTORY and NEXT_PUBLIC_INDEXER_URL to point at a deployment.",
  },
} as const;

export type TranslationKey = keyof (typeof dictionary)["en"];

type I18nState = {
  locale: Locale;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nState | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale: Locale = "en";

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      const template: string = dictionary[locale][key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in vars ? String(vars[name]) : match,
      );
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside <I18nProvider>");
  return context;
}

/**
 * Clock formatting that follows the toggle, not the browser.
 *
 * Someone reading the board in Portuguese expects 14:35, and getting 02:35 PM
 * on half the screen while the other half speaks Portuguese is the seam that
 * makes a terminal feel machine-translated. Prices stay en-US on purpose — they
 * are dollars.
 */
export function useClock(): (unixSeconds: number) => string {
  const { locale } = useI18n();
  return useCallback(
    (unixSeconds: number) =>
      new Date(unixSeconds * 1000).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );
}
