"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Portuguese and English, both first-class.
 *
 * The first users are Brazilian orderflow traders, so pt-BR is not a
 * translation layer bolted on afterwards — it is the default when the browser
 * says pt, and the vocabulary is the one a tape reader actually uses ("livro",
 * "fita", "ponta"), not a literal rendering of the English.
 */

export type Locale = "pt-BR" | "en";

const dictionary = {
  "pt-BR": {
    "app.tagline": "Grade de previsão na Monad. Cada célula é um mercado de 5 min no livro da Kuru.",
    "nav.docs": "Como funciona",
    "nav.github": "GitHub",

    "wallet.connect": "Conectar carteira",
    "wallet.connecting": "Conectando…",
    "wallet.none": "Nenhuma carteira encontrada",
    "wallet.wrongChain": "Rede errada",
    "wallet.switch": "Mudar para {chain}",

    "grid.title": "Grade",
    "grid.strike": "Strike",
    "grid.now": "Agora",
    "grid.settles": "Fecha",
    "grid.empty": "Sem células nesta janela. Rode o roller para abrir a próxima coluna.",
    "grid.noBook": "sem livro",
    "grid.atm": "no dinheiro",
    "grid.legend": "Número grande = quanto paga (1,9x). Verde = YES no dinheiro, vermelho = fora. Linha branca = BTC.",
    "grid.live": "ao vivo",
    "grid.settled": "liquidado",
    "grid.closed": "fechada",
    "grid.settling": "liquidando",

    "cell.select": "Clique numa célula para ver o livro.",
    "cell.above": "BTC acima de {strike} às {time}",
    "cell.timeLeft": "Tempo",
    "cell.expired": "Encerrada",
    "cell.book": "Livro",
    "cell.tape": "Fita",
    "cell.flow": "Fluxo",
    "cell.notes": "Notas",
    "cell.makers": "Na ponta",
    "cell.makersShort": "Ponta",
    "cell.noMakers": "Ninguém no livro ainda.",
    "cell.bid": "Compra",
    "cell.ask": "Venda",
    "cell.price": "Preço",
    "cell.size": "Qtd",
    "cell.orders": "Ordens",
    "cell.spread": "Spread",
    "cell.mid": "Meio",
    "cell.last": "Último",
    "cell.volume": "Volume",
    "cell.oi": "Em aberto",
    "cell.cvd": "CVD",
    "cell.noFills": "Nenhum negócio ainda.",
    "cell.outcome.yes": "Liquidada em YES",
    "cell.outcome.no": "Liquidada em NO",
    "cell.outcome.void": "Anulada — cada perna paga 0,50",

    "ticket.title": "Ordem",
    "ticket.side": "Perna",
    "ticket.buy": "Comprar",
    "ticket.sell": "Vender",
    "ticket.limitPrice": "Preço limite",
    "ticket.contracts": "Contratos",
    "ticket.postOnly": "Somente pós (não cruza)",
    "ticket.cost": "Custo",
    "ticket.maxLoss": "Perda máxima",
    "ticket.premium": "Prêmio recebido",
    "ticket.maxPayout": "Retorno máximo",
    "ticket.profit": "Lucro se acertar",
    "ticket.place": "Enviar para a Kuru",
    "ticket.placing": "Enviando…",
    "ticket.cancel": "Cancelar todas",
    "ticket.myOrders": "Minhas ordens",
    "ticket.noOrders": "Nenhuma ordem aberta nesta célula.",
    "ticket.needWallet": "Conecte a carteira para operar.",
    "ticket.needInventory":
      "Para vender esta perna você precisa dos tokens. Trave colateral e receba YES + NO.",
    "ticket.mint": "Travar {amount} e emitir YES + NO",
    "ticket.minting": "Emitindo…",
    "ticket.redeem": "Resgatar",
    "ticket.sent": "Enviada",
    "ticket.failed": "Falhou",

    "notes.title": "Notas privadas",
    "notes.blurb":
      "Criptografadas com a sua passkey. O servidor guarda só o texto cifrado — a mesma passkey em outro aparelho abre as mesmas notas.",
    "notes.enroll": "Criar passkey",
    "notes.unlock": "Desbloquear com passkey",
    "notes.locked": "Bloqueado",
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
      "Cada contrato paga 1 unidade de colateral se a perna vencer e 0 se perder. Você pode perder tudo o que colocou. A liquidação usa um preço de referência público na hora de fechamento. Rede de teste: os tokens não valem dinheiro.",
    "risk.accept": "Entendi",
    "risk.more": "Risco",

    "status.indexer": "Indexador",
    "status.stale": "atrasado {seconds}s",
    "status.down": "fora do ar",
    "status.live": "ao vivo",
    "status.notConfigured":
      "Defina NEXT_PUBLIC_CELL_FACTORY e NEXT_PUBLIC_INDEXER_URL para conectar a um deploy.",
  },

  en: {
    "app.tagline": "A prediction grid on Monad. Every cell is a 5-minute market on Kuru's book.",
    "nav.docs": "How it works",
    "nav.github": "GitHub",

    "wallet.connect": "Connect wallet",
    "wallet.connecting": "Connecting…",
    "wallet.none": "No wallet found",
    "wallet.wrongChain": "Wrong network",
    "wallet.switch": "Switch to {chain}",

    "grid.title": "Grid",
    "grid.strike": "Strike",
    "grid.now": "Now",
    "grid.settles": "Settles",
    "grid.empty": "No cells in this window. Run the roller to open the next column.",
    "grid.noBook": "no book",
    "grid.atm": "at the money",
    "grid.legend": "The big number is what it pays (1.9x). Green is YES in the money, red is out. White line is BTC.",
    "grid.live": "live",
    "grid.settled": "settled",
    "grid.closed": "closed",
    "grid.settling": "settling",

    "cell.select": "Pick a cell to see its book.",
    "cell.above": "BTC above {strike} at {time}",
    "cell.timeLeft": "Time",
    "cell.expired": "Closed",
    "cell.book": "Book",
    "cell.tape": "Tape",
    "cell.flow": "Flow",
    "cell.notes": "Notes",
    "cell.makers": "On the book",
    "cell.makersShort": "Makers",
    "cell.noMakers": "Nobody quoting yet.",
    "cell.bid": "Bid",
    "cell.ask": "Ask",
    "cell.price": "Price",
    "cell.size": "Size",
    "cell.orders": "Orders",
    "cell.spread": "Spread",
    "cell.mid": "Mid",
    "cell.last": "Last",
    "cell.volume": "Volume",
    "cell.oi": "Open interest",
    "cell.cvd": "CVD",
    "cell.noFills": "No trades yet.",
    "cell.outcome.yes": "Settled YES",
    "cell.outcome.no": "Settled NO",
    "cell.outcome.void": "Voided — each leg pays 0.50",

    "ticket.title": "Order",
    "ticket.side": "Leg",
    "ticket.buy": "Buy",
    "ticket.sell": "Sell",
    "ticket.limitPrice": "Limit price",
    "ticket.contracts": "Contracts",
    "ticket.postOnly": "Post only (never cross)",
    "ticket.cost": "Cost",
    "ticket.maxLoss": "Max loss",
    "ticket.premium": "Premium received",
    "ticket.maxPayout": "Max payout",
    "ticket.profit": "Profit if right",
    "ticket.place": "Send to Kuru",
    "ticket.placing": "Sending…",
    "ticket.cancel": "Cancel all",
    "ticket.myOrders": "My orders",
    "ticket.noOrders": "No open orders on this cell.",
    "ticket.needWallet": "Connect a wallet to trade.",
    "ticket.needInventory": "Selling this leg needs the token. Lock collateral to mint YES + NO.",
    "ticket.mint": "Lock {amount} and mint YES + NO",
    "ticket.minting": "Minting…",
    "ticket.redeem": "Redeem",
    "ticket.sent": "Sent",
    "ticket.failed": "Failed",

    "notes.title": "Private notes",
    "notes.blurb":
      "Encrypted with your passkey. The server only ever holds ciphertext — the same passkey on a second device opens the same notes.",
    "notes.enroll": "Create passkey",
    "notes.unlock": "Unlock with passkey",
    "notes.locked": "Locked",
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
      "Each contract pays 1 unit of collateral if its leg wins and 0 if it loses. You can lose everything you put in. Settlement uses a public reference price at the close of the window. On testnet the tokens are worth nothing.",
    "risk.accept": "Understood",
    "risk.more": "Risk",

    "status.indexer": "Indexer",
    "status.stale": "{seconds}s behind",
    "status.down": "down",
    "status.live": "live",
    "status.notConfigured":
      "Set NEXT_PUBLIC_CELL_FACTORY and NEXT_PUBLIC_INDEXER_URL to point at a deployment.",
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
    if (next && next !== locale) setLocaleState(next);
    // Intentionally once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
