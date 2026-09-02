import type { Metadata, Viewport } from "next";
import { Bagel_Fat_One, Fredoka, IBM_Plex_Mono, Nunito } from "next/font/google";

import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { WalletProvider } from "@/lib/wallet";

/**
 * Four faces, four jobs.
 *
 * Bagel Fat One is the mark — balloon letters, used once, on the word "Pit".
 * Fredoka is the readout: fat, round, the 2.5x on a tile and the TO WIN. Nunito
 * handles the words. Plex Mono still runs the book, because a tape has to be a
 * column of numbers, not a cartoon.
 */
const mark = Bagel_Fat_One({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-bagel",
  display: "swap",
});

const display = Fredoka({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-fredoka",
  display: "swap",
});

const data = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

const label = Nunito({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--font-nunito",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pit — the five-minute option chain",
  description:
    "A board of five-minute YES/NO markets on BTC, each listed as a spot pair on Kuru's onchain order book. Indexed by Envio, settled by a Chainlink CRE workflow.",
};

export const viewport: Viewport = {
  themeColor: "#1a1224",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${mark.variable} ${display.variable} ${data.variable} ${label.variable}`}
    >
      <body>
        <I18nProvider>
          <WalletProvider>{children}</WalletProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
