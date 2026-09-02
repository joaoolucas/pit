import type { Metadata, Viewport } from "next";

import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { WalletProvider } from "@/lib/wallet";

export const metadata: Metadata = {
  title: "Cell — a prediction grid on Monad",
  description:
    "A live BTC chart as a board of cells. Every cell is a 5-minute YES/NO market listed on Kuru's onchain CLOB, indexed by Envio and settled by a Chainlink CRE workflow.",
};

export const viewport: Viewport = {
  themeColor: "#06080b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          <WalletProvider>{children}</WalletProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
