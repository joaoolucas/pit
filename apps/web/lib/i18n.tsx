"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Portuguese and English, both first-class.
 *
 * The first users are Brazilian orderflow traders, so pt-BR is not a layer
 * bolted on afterwards — it is the default when the browser says pt, and the
 * vocabulary is the one a tape reader actually uses ("livro", "fita", "ponta"),
 * not a literal rendering of the English.
 *
 * Two rules for the copy in here. An action names what happens when it is used
 * and keeps that name through the whole flow: the button that says "Comprar YES
 * a 62¢" produces "Comprou 40 YES a 62¢". And an empty state is an instruction,
 * not a mood — "nobody is quoting this one yet" is followed by what to do about
 * it.
 */

export type Locale = "pt-BR" | "en";

const dictionary = {
  "pt-BR": {
    "app.tagline": "A cadeia de opções de 5 minutos, no livro onchain da Kuru.",

    "wallet.connect": "Conectar carteira",
    "wallet.connecting": "Conectando…",
    "wallet.none": "Nenhuma carteira encontrada",
    "wallet.switch": "Mudar para {chain}",

    "board.empty": "Nenhuma célula neste intervalo.",
    "board.emptyHint":
      "O roller abre as próximas colunas a cada minuto. Rode {command} para abrir agora.",
    "board.realised": "Últimos {minutes} min",
    "board.now": "Agora",
    "board.strike": "Strike",
    "board.strikeAxis": "BTC acima de",
    "board.closed": "fechada",
    "board.settling": "liquidando",
    "board.yes": "YES",
    "board.no": "NO",
    "board.void": "ANUL",
    "board.spot": "Preço agora",
    "board.legendPay": "Número = quanto paga",
    "board.legendDepth": "Cor = lado e tamanho no livro",
    "board.legendHollow": "Vazado = ninguém cotando",
    "board.legendTrace": "Preço do BTC",
    "board.legendHint": "Clique numa célula para operar",
    "board.noDepth": "sem livro",
    "board.cardDepth": "No livro",
    "board.cardMakers": "Cotando",
    "board.cardSpread": "Spread",
    "board.cardLeft": "faltam {clock}",
    "board.cardClosed": "fechada",
    "board.titleWidth": "spread {width}",
    "board.titleMakers": "{makers} na ponta",

    "cell.select": "Escolha uma célula.",
    "cell.selectHint": "Você vê o livro ao vivo, a fita e quem está cotando — e pode cotar também.",
    "cell.claim": "BTC acima de {strike}",
    "cell.closes": "fecha {time}",
    "cell.expired": "encerrada",
    "cell.book": "Livro",
    "cell.tape": "Fita",
    "cell.flow": "Fluxo",
    "cell.notes": "Notas",
    "cell.makers": "Na ponta",
    "cell.noMakers": "Ninguém cotando ainda.",
    "cell.noBook": "Livro vazio.",
    "cell.noBookHint": "Poste um preço na aba Cotar e você é a primeira ponta desta célula.",
    "cell.price": "Preço",
    "cell.size": "Qtd",
    "cell.orders": "Ordens",
    "cell.width": "Spread",
    "cell.usePrice": "Usar este preço",
    "cell.traded": "negociados",
    "cell.cvd": "CVD",
    "cell.noFills": "Nenhum negócio ainda.",
    "cell.onKuru": "Livro na Kuru · {market}",
    "cell.arb": "compre as duas pernas e trave {edge}",
    "cell.overround": "{over} de spread nas duas pernas",
    "cell.outcome.yes": "Liquidada em YES",
    "cell.outcome.no": "Liquidada em NO",
    "cell.outcome.void": "Anulada · cada perna paga 50¢",

    "ticket.take": "Tomar",
    "ticket.make": "Cotar",
    "ticket.yes": "YES",
    "ticket.no": "NO",
    "ticket.amount": "Quanto em dólares",
    "ticket.toWin": "Recebe se acertar",
    "ticket.takeDetail": "{contracts} contratos a {price} · custa ${spend} · {multiple}",
    "ticket.noOffer": "Ninguém vendendo esta perna",
    "ticket.tooSmall": "Aumente o valor: não dá para um contrato inteiro.",
    "ticket.buyAction": "Comprar {side} a {price}",
    "ticket.price": "Preço",
    "ticket.size": "Contratos",
    "ticket.makeDetail": "Trava ${locks} {symbol} e paga ${pays} se a perna vencer.",
    "ticket.makeInvalid": "Preço entre 1¢ e 99¢, quantidade acima de zero.",
    "ticket.postBid": "Postar compra",
    "ticket.postAsk": "Postar venda",
    "ticket.needInventory":
      "Para vender uma perna você precisa dos tokens. Trave colateral e receba YES + NO.",
    "ticket.mint": "Travar {size} {symbol} e emitir YES + NO",
    "ticket.myOrders": "Minhas ordens",
    "ticket.cancelAll": "Cancelar todas",
    "ticket.noOrders": "Nenhuma ordem aberta nesta célula.",
    "ticket.bid": "compra",
    "ticket.ask": "venda",
    "ticket.needWallet": "Conecte a carteira para operar.",
    "ticket.redeem": "Resgatar",
    "ticket.redeemBlurb": "A perna vencedora paga $1 por contrato.",
    "ticket.sending": "Enviando…",
    "ticket.posting": "Postando…",
    "ticket.cancelling": "Cancelando…",
    "ticket.minting": "Emitindo…",
    "ticket.redeeming": "Resgatando…",
    "ticket.bought": "Comprou {contracts} {side} a {price}.",
    "ticket.posted": "Postou {size} {side} a {price}.",
    "ticket.cancelled": "Ordens canceladas.",
    "ticket.minted": "Emitiu {size} YES + {size} NO.",
    "ticket.redeemed": "Resgatado.",

    "notes.blurb":
      "Criptografadas com a sua passkey. O servidor guarda só o texto cifrado — a mesma passkey em outro aparelho abre as mesmas notas.",
    "notes.enroll": "Criar passkey",
    "notes.unlock": "Desbloquear com passkey",
    "notes.unlocking": "Aguardando a passkey…",
    "notes.placeholder": "Por que você está nesta célula? Só você lê isto.",
    "notes.save": "Salvar",
    "notes.saving": "Salvando…",
    "notes.saved": "Salvo",
    "notes.lock": "Bloquear",
    "notes.unsupported": "Este navegador não expõe a extensão PRF do WebAuthn.",
    "notes.crossDevice": "Cofre {vault} · aberto com a passkey",

    "risk.title": "Isto é um mercado de previsão. Leia antes de operar.",
    "risk.body":
      "Cada contrato paga $1 se a perna vencer e nada se perder. Você pode perder tudo o que colocou. A liquidação usa um preço de referência público no fechamento da janela. Rede de teste: os tokens não valem dinheiro.",
    "risk.accept": "Entendi",
    "risk.more": "Risco",

    "status.indexer": "Indexador",
    "status.stale": "atrasado {seconds}s",
    "status.down": "fora do ar",
    "status.live": "ao vivo",
    "status.loading": "Carregando o tabuleiro",
    "status.notConfigured":
      "Defina NEXT_PUBLIC_PIT_FACTORY e NEXT_PUBLIC_INDEXER_URL para conectar a um deploy.",
  },

  en: {
    "app.tagline": "The five-minute option chain, on Kuru's onchain book.",

    "wallet.connect": "Connect wallet",
    "wallet.connecting": "Connecting…",
    "wallet.none": "No wallet found",
    "wallet.switch": "Switch to {chain}",

    "board.empty": "No cells in this range.",
    "board.emptyHint":
      "The roller opens the next columns every minute. Run {command} to open them now.",
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
    "board.cardDepth": "On the book",
    "board.cardMakers": "Quoting",
    "board.cardSpread": "Spread",
    "board.cardLeft": "{clock} left",
    "board.cardClosed": "closed",
    "board.titleWidth": "{width} wide",
    "board.titleMakers": "{makers} quoting",

    "cell.select": "Pick a cell.",
    "cell.selectHint": "You get the live book, the tape and who is quoting — and you can quote too.",
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
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nState | null>(null);

const STORAGE_KEY = "cell.locale";

export function I18nProvider({ children }: { children: ReactNode }) {
  // Start on en so server and first client render agree, then adopt the stored
  // or browser preference. Guessing during SSR would only cause a flash.
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    let next: Locale | null = null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "pt-BR" || stored === "en") next = stored;
    } catch {
      /* storage unavailable; fall through to the browser hint */
    }
    if (!next && navigator.language?.toLowerCase().startsWith("pt")) next = "pt-BR";
    if (next) setLocaleState(next);
    // Intentionally once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A screen reader reads the page in whatever `lang` says, so a Portuguese
  // board announced as English is not a nicety — it is unintelligible.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* a preference we cannot persist is still a preference for this session */
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      const template: string = dictionary[locale][key] ?? dictionary.en[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in vars ? String(vars[name]) : match,
      );
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
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
