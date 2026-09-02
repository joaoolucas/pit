import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Condensed, Martian_Mono } from "next/font/google";

import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { WalletProvider } from "@/lib/wallet";

/**
 * Three faces, three jobs.
 *
 * Martian Mono is wide and mechanical — it is the readout face, used only for
 * the handful of numbers that carry a decision: the multiple on a tile, spot,
 * the clock. Plex Mono runs the tables, where tabular figures and a narrow
 * advance matter more than character. Plex Sans Condensed handles labels,
 * because a dense board needs its words to take less room than its numbers.
 */
const display = Martian_Mono({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-martian",
  display: "swap",
});

const data = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

const label = IBM_Plex_Sans_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-condensed",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pit — the five-minute option chain",
  description:
    "A board of five-minute YES/NO markets on BTC, each listed as a spot pair on Kuru's onchain order book. Indexed by Envio, settled by a Chainlink CRE workflow.",
};

export const viewport: Viewport = {
  themeColor: "#08151c",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${data.variable} ${label.variable}`}>
      <body>
        <I18nProvider>
          <WalletProvider>{children}</WalletProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
